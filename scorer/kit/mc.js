/* kit/mc.js — WebMCP access layer for the build yard.
 *
 * Loads first on every page. Exposes:
 *   window.mc       — a ModelContext with one surface in both modes:
 *                     native `document.modelContext` when the browser ships WebMCP,
 *                     otherwise a shim that mirrors the spec and Chrome's measured
 *                     behaviour (registerTool / getTools / executeTool / toolchange,
 *                     exposedTo + fromOrigins cross-origin gating, AbortSignal
 *                     unregister, declarative <form toolname> tools).
 *                     One convenience on top of the spec in both modes:
 *                     executeTool accepts a tool name or a RegisteredTool, and an
 *                     input object or a JSON string.
 *   window.__agent  — { tools(fromOrigins?), call(nameOrTool, input?) } used by the
 *                     in-app "Simulate agent" panels and by the Playwright tests.
 *   window.MC       — { native, origin(key), origins, isMulti, whenChild(iframe), ready() }.
 *   'mc-toolchange' — fired on window whenever the visible tool set changes (both modes).
 *
 * Spec: https://webmachinelearning.github.io/webmcp/  (IDL as of 2026-09)
 * Measured against Chrome 151/152 with --enable-features=WebMCPTesting.
 */
(() => {
  'use strict';

  const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
  const WIRE = 'mcpb/2';
  const PING_MS = 300;
  const PROBE_MS = 700;    // unknown frame: is anything in there running the kit at all?
  const FRAME_MS = 20000;  // frame that has answered before: wait for it, the way native getTools() does
  const EXEC_MS = 120000;
  const nativeMC =
    document.modelContext && typeof document.modelContext.registerTool === 'function'
      ? document.modelContext
      : null;

  // ---------------------------------------------------------------- utilities
  const KIT_ERROR = Symbol('kit-error');
  const domError = (message, name) => Object.assign(new DOMException(message, name), { [KIT_ERROR]: true });
  const randomId = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const selfOrigin = () => window.location.origin;

  /** Serialize an origin string the way the spec does, or null when it is not potentially trustworthy. */
  const trustworthyOrigin = (value) => {
    let url;
    try { url = new URL(String(value)); } catch { return null; }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const local = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
    const secure = url.protocol === 'https:' || url.protocol === 'wss:' || url.protocol === 'file:';
    if (!(secure || local)) return null;
    return url.origin === 'null' ? null : url.origin;
  };

  /** Chrome/spec result serialization: strings pass through, everything else is JSON. */
  const serializeResult = (value) => {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    const json = JSON.stringify(value);
    if (json === undefined) throw domError('tool result is not JSON-serializable', 'UnknownError');
    return json;
  };

  const parseInput = (input) => {
    if (input === undefined || input === null) return {};
    if (typeof input !== 'string') return input;
    try { return JSON.parse(input); } catch { throw domError('Failed to parse input arguments', 'UnknownError'); }
  };

  const fireWindowEvent = (type, detail) => {
    const ev = new Event(type);
    Object.assign(ev, detail);
    window.dispatchEvent(ev);
  };

  // ------------------------------------------------------------ frame messaging
  const pending = new Map();      // id -> {resolve, timer}
  const knownKit = new WeakSet(); // windows that have spoken the kit protocol at least once

  const post = (win, msg, targetOrigin) => {
    try { win.postMessage({ ...msg, wire: WIRE }, targetOrigin || '*'); return true; } catch { return false; }
  };

  const rpc = (win, msg, { targetOrigin, timeout } = {}) =>
    new Promise((resolve) => {
      const id = randomId();
      const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeout || PROBE_MS);
      pending.set(id, { resolve: (reply) => { if (reply) knownKit.add(win); resolve(reply); }, timer });
      if (!post(win, { ...msg, id }, targetOrigin)) { clearTimeout(timer); pending.delete(id); resolve(null); }
    });

  /** Ask a frame, waiting like native does once we know the kit is running in it.
   *  A frame that has never answered gets one short probe; a known one gets the full wait, and a
   *  miss is reported rather than silently dropping its tools. */
  const frameRpc = async (win, msg) => {
    const known = knownKit.has(win);
    const reply = await rpc(win, msg, { timeout: known ? FRAME_MS : PROBE_MS });
    if (!reply && known) console.warn('WebMCP kit: a frame did not answer within ' + FRAME_MS + ' ms; its tools are missing from this result');
    return reply;
  };

  const reply = (ev, id, body) => post(ev.source, { kind: 'reply', id, ...body }, ev.origin === 'null' ? '*' : ev.origin);

  let rootPromise = null;
  /** The topmost ancestor window that runs this kit (falls back to self). */
  const findRoot = () => {
    if (!rootPromise) {
      rootPromise = (async () => {
        let win = window;
        while (win.parent && win.parent !== win) {
          // a busy parent is not an absent one: probe again for longer before concluding we are the root
          const pong = (await rpc(win.parent, { kind: 'ping' }, { timeout: PING_MS }))
            || (await rpc(win.parent, { kind: 'ping' }, { timeout: 2000 }));
          if (!pong) { if (win === window) rootPromise = null; break; } // parent not running the kit: retry next call
          win = win.parent;
        }
        return win;
      })();
    }
    return rootPromise;
  };

  const walkPath = (root, path) => {
    let win = root;
    for (const index of path) win = win.frames[index];
    return win;
  };

  // ------------------------------------------------------------------- shim
  const registry = new Map(); // name -> record
  const shimTarget = new EventTarget();

  const toolIsVisible = (record, askerOrigin) =>
    record.origin === askerOrigin || record.exposedTo.includes(askerOrigin);

  const publicTool = (record) => ({
    name: record.name,
    title: record.title,
    description: record.description,
    inputSchema: record.schemaJSON ? JSON.parse(record.schemaJSON) : undefined,
    origin: record.origin,
    annotations: record.annotations,
  });

  const broadcastToolchange = () => {
    for (let i = 0; i < window.frames.length; i++) post(window.frames[i], { kind: 'toolchange' });
  };

  const notifyToolchange = async () => {
    shimTarget.dispatchEvent(new Event('toolchange'));
    fireWindowEvent('mc-toolchange');
    const root = await findRoot();
    if (root === window) broadcastToolchange();
    else post(root, { kind: 'toolchange' });
  };

  const unregister = (name) => {
    if (!registry.delete(name)) return;
    notifyToolchange();
  };

  const runLocal = async (record, inputObject, signal) => {
    const controller = new AbortController();
    if (signal) signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    const abort = signal ? new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true })) : null;
    let value;
    try {
      const run = Promise.resolve(record.execute(inputObject, { signal: controller.signal }));
      value = await (abort ? Promise.race([run, abort]) : run);
    } catch (reason) {
      if (signal && signal.aborted) throw signal.reason;
      if (reason && reason[KIT_ERROR]) throw reason;
      console.error('WebMCP tool execution failed:', reason);
      throw domError('Tool was executed but the invocation failed. For example, the script function threw an error', 'UnknownError');
    }
    if (signal && signal.aborted) throw signal.reason;
    return serializeResult(value);
  };

  /** Own visible tools for `askerOrigin`, plus the tools of every descendant frame (with their frame path). */
  const collect = async (askerOrigin, fromOrigins, path) => {
    const out = [];
    const requested = askerOrigin === selfOrigin() || fromOrigins.includes(selfOrigin());
    if (requested) {
      for (const record of registry.values()) {
        if (toolIsVisible(record, askerOrigin)) out.push({ ...publicTool(record), path });
      }
    }
    const children = [];
    for (let i = 0; i < window.frames.length; i++) {
      children.push(frameRpc(window.frames[i], { kind: 'collect', forwarded: true, asker: askerOrigin, fromOrigins, path: [...path, i] }));
    }
    for (const res of await Promise.all(children)) if (res && res.tools) out.push(...res.tools);
    return out;
  };

  const shim = {
    registerTool(tool, options = {}) {
      return new Promise((resolve, reject) => {
        if (!tool || typeof tool !== 'object') return reject(new TypeError("Failed to execute 'registerTool' on 'ModelContext': parameter 1 is not of type 'ModelContextTool'."));
        if (tool.description === undefined) return reject(new TypeError("Failed to execute 'registerTool' on 'ModelContext': Failed to read the 'description' property from 'ModelContextTool': Required member is undefined."));
        if (typeof tool.execute !== 'function') return reject(new TypeError("Failed to execute 'registerTool' on 'ModelContext': Failed to read the 'execute' property from 'ModelContextTool': Required member is undefined."));
        const name = String(tool.name);
        if (registry.has(name)) return reject(domError('Duplicate tool name', 'InvalidStateError'));
        if (!tool.description) return reject(domError('Description is required', 'InvalidStateError'));
        if (!NAME_RE.test(name)) return reject(domError('Invalid tool name', 'InvalidStateError'));
        let schemaJSON = '';
        if (tool.inputSchema !== undefined) {
          if (typeof tool.inputSchema !== 'object' || tool.inputSchema === null) return reject(new TypeError("Failed to execute 'registerTool' on 'ModelContext': Failed to read the 'inputSchema' property from 'ModelContextTool': Failed to convert value to 'object'."));
          try { schemaJSON = JSON.stringify(tool.inputSchema); } catch (e) { return reject(e); }
          if (schemaJSON === undefined) return reject(new TypeError('inputSchema is not JSON-serializable'));
        }
        if (options.signal && options.signal.aborted) return reject(options.signal.reason);
        const exposedTo = [];
        if (options.exposedTo !== undefined) {
          if (typeof options.exposedTo === 'string' || typeof options.exposedTo[Symbol.iterator] !== 'function') return reject(new TypeError("Failed to execute 'registerTool' on 'ModelContext': Failed to read the 'exposedTo' property from 'ModelContextRegisterToolOptions': The provided value cannot be converted to a sequence."));
          for (const entry of options.exposedTo) {
            const origin = trustworthyOrigin(entry);
            if (!origin) return reject(domError('Only secure origins are allowed in the exposedTo list.', 'SecurityError'));
            exposedTo.push(origin);
          }
        }
        const record = {
          name,
          title: tool.title === undefined ? '' : String(tool.title),
          description: String(tool.description),
          schemaJSON,
          execute: tool.execute,
          annotations: tool.annotations
            ? { readOnlyHint: !!tool.annotations.readOnlyHint, untrustedContentHint: !!tool.annotations.untrustedContentHint }
            : null,
          exposedTo,
          origin: selfOrigin(),
        };
        registry.set(name, record);
        if (options.signal) options.signal.addEventListener('abort', () => unregister(name), { once: true });
        notifyToolchange();
        resolve(undefined);
      });
    },

    async getTools(options = {}) {
      const fromOrigins = [];
      if (options.fromOrigins !== undefined) {
        if (typeof options.fromOrigins === 'string' || typeof options.fromOrigins[Symbol.iterator] !== 'function') throw new TypeError("Failed to execute 'getTools' on 'ModelContext': Failed to read the 'fromOrigins' property from 'ModelContextGetToolOptions': The provided value cannot be converted to a sequence.");
        for (const entry of options.fromOrigins) {
          const origin = trustworthyOrigin(entry);
          if (!origin) throw domError('Only secure origins are allowed in the fromOrigins list.', 'SecurityError');
          fromOrigins.push(origin);
        }
      }
      const root = await findRoot();
      const tools = root === window
        ? await collect(selfOrigin(), fromOrigins, [])
        : ((await frameRpc(root, { kind: 'collect', fromOrigins, path: [] })) || { tools: [] }).tools;
      const out = tools.map(({ path, ...tool }) => ({ ...tool, window: walkPath(root, path) }));
      out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return out;
    },

    async executeTool(tool, input = {}, options = {}) {
      if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || !tool.window) throw new TypeError("Failed to execute 'executeTool' on 'ModelContext': The provided value is not of type 'RegisteredTool'.");
      if (options.signal && options.signal.aborted) throw options.signal.reason;
      const inputJSON = typeof input === 'string' ? input : JSON.stringify(input);
      const inputObject = parseInput(inputJSON);
      if (tool.window === window) {
        const record = registry.get(tool.name);
        if (!record) throw domError('The tool is no longer registered', 'UnknownError');
        return runLocal(record, inputObject, options.signal);
      }
      const abort = options.signal
        ? new Promise((_, rej) => options.signal.addEventListener('abort', () => rej(options.signal.reason), { once: true }))
        : null;
      const call = rpc(tool.window, { kind: 'exec', name: tool.name, input: inputJSON }, { targetOrigin: tool.origin, timeout: EXEC_MS });
      const res = await (abort ? Promise.race([call, abort]) : call);
      if (res === null) return null; // navigation or unreachable frame
      if (res.error) throw domError(res.error.message, res.error.name);
      return res.result;
    },

    addEventListener: (...a) => shimTarget.addEventListener(...a),
    removeEventListener: (...a) => shimTarget.removeEventListener(...a),
    dispatchEvent: (e) => shimTarget.dispatchEvent(e),
  };

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.wire !== WIRE) return;
    if (ev.source) knownKit.add(ev.source); // this window speaks the kit protocol
    if (d.kind === 'reply') {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      clearTimeout(p.timer);
      p.resolve(d);
      return;
    }
    if (d.kind === 'ping') { reply(ev, d.id, { ready: window.__appReady === true, origin: selfOrigin() }); return; }
    if (d.kind === 'toolchange') {
      shimTarget.dispatchEvent(new Event('toolchange'));
      fireWindowEvent('mc-toolchange');
      broadcastToolchange();
      return;
    }
    if (nativeMC) return; // native answers its own tool traffic
    if (d.kind === 'collect') {
      const asker = d.forwarded ? d.asker : ev.origin; // only a parent-forwarded request may name the asker
      collect(asker, d.fromOrigins || [], d.path || []).then((tools) => reply(ev, d.id, { tools }));
      return;
    }
    if (d.kind === 'exec') {
      const record = registry.get(d.name);
      if (!record || !toolIsVisible(record, ev.origin)) { reply(ev, d.id, { error: { name: 'UnknownError', message: 'The tool is not available to ' + ev.origin } }); return; }
      let inputObject;
      try { inputObject = parseInput(d.input); } catch (e) { reply(ev, d.id, { error: { name: e.name, message: e.message } }); return; }
      runLocal(record, inputObject).then(
        (result) => reply(ev, d.id, { result }),
        (e) => reply(ev, d.id, { error: { name: e.name || 'UnknownError', message: e.message || String(e) } }),
      );
    }
  });

  // --------------------------------------------------- declarative forms (shim)
  const FORMAT = {
    time: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
    'datetime-local': '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$',
    month: '^[0-9]{4}-(0[1-9]|1[0-2])$',
    week: '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$',
    color: '^#[0-9a-zA-Z]{6}$',
  };
  const SKIPPED_TYPES = new Set(['submit', 'button', 'reset', 'image', 'hidden', 'file']);

  const labelText = (el) => {
    if (el.labels && el.labels.length) {
      const clone = el.labels[0].cloneNode(true);
      clone.querySelectorAll('input,select,textarea,button,output,meter,progress').forEach((n) => n.remove());
      return clone.textContent.trim();
    }
    return el.getAttribute('aria-description') || '';
  };

  const optionSchema = (el) => ({
    type: 'string',
    anyOf: [...el.options].map((o) => ({ type: 'string', const: o.value, title: o.label || o.text })),
    enum: [...el.options].map((o) => o.value),
  });

  const numberSchema = (el) => {
    const p = { type: 'number' };
    const min = el.type === 'range' ? (el.min === '' ? 0 : Number(el.min)) : (el.min === '' ? null : Number(el.min));
    const max = el.type === 'range' ? (el.max === '' ? 100 : Number(el.max)) : (el.max === '' ? null : Number(el.max));
    if (min !== null && Number.isFinite(min)) p.minimum = min;
    if (max !== null && Number.isFinite(max)) p.maximum = max;
    if (el.step !== 'any') p.multipleOf = el.step === '' ? 1 : Number(el.step);
    return p;
  };

  const synthesizeSchema = (form) => {
    const properties = {};
    const required = [];
    const radios = new Map();
    for (const el of form.elements) {
      if (!el.name || el.disabled || el.readOnly || SKIPPED_TYPES.has(el.type)) continue;
      if (el.type === 'radio') {
        const group = radios.get(el.name) || { options: [], required: false };
        const option = { type: 'string', const: el.value };
        const title = el.labels && el.labels.length ? labelText(el) : '';
        if (title) option.title = title;
        group.options.push(option);
        group.required = group.required || el.required;
        radios.set(el.name, group);
        continue;
      }
      let p;
      if (el.tagName === 'SELECT') {
        p = el.multiple ? { type: 'array', items: optionSchema(el), uniqueItems: true } : optionSchema(el);
      } else if (el.type === 'number' || el.type === 'range') {
        p = numberSchema(el);
      } else if (el.type === 'checkbox') {
        p = { type: 'boolean' };
      } else {
        p = { type: 'string' };
        if (el.type === 'date') p.format = 'date';
        else if (FORMAT[el.type]) p.format = FORMAT[el.type];
        if (el.pattern) p.pattern = el.pattern;
      }
      const description = el.getAttribute('toolparamdescription') || labelText(el);
      if (description) p.description = el.type === 'date' ? `${description} (Dates MUST be provided in 'YYYY-MM-DD' format.)` : description;
      properties[el.name] = p;
      if (el.required) required.push(el.name);
    }
    for (const [name, group] of radios) {
      properties[name] = { type: 'string', anyOf: group.options, enum: group.options.map((o) => o.const) };
      if (group.required) required.push(name);
    }
    return { type: 'object', properties, required };
  };

  const validateDeclarativeInput = (form, input) => {
    const schema = synthesizeSchema(form);
    for (const [name, value] of Object.entries(input)) {
      if (!schema.properties[name]) throw domError(`Input contains a parameter "${name}" but there is no such parameter for the tool`, 'UnknownError');
      const el = form.elements.namedItem(name);
      if (!el) continue;
      if (schema.properties[name].type === 'number' && (value === '' || Number.isNaN(Number(value)))) throw domError(`Invalid value "${value}" for parameter ${name}`, 'UnknownError');
      const select = el.tagName === 'SELECT' ? el : null;
      if (select && select.multiple) {
        if (!Array.isArray(value) || value.some((v) => ![...select.options].some((o) => o.value === String(v)))) {
          throw domError(`Invalid value "${value}" for parameter ${name}`, 'UnknownError');
        }
      } else if (select) {
        if (![...select.options].some((o) => o.value === String(value))) throw domError(`Invalid value "${value}" for parameter ${name}`, 'UnknownError');
      } else if (typeof RadioNodeList === 'function' && el instanceof RadioNodeList) {
        if (![...el].some((r) => r.value === String(value))) throw domError(`Invalid value "${value}" for parameter ${name}`, 'UnknownError');
      }
    }
  };

  const fillField = (form, name, value) => {
    const el = form.elements.namedItem(name);
    if (!el) return;
    const fire = (target) => { target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true })); };
    if (typeof RadioNodeList === 'function' && el instanceof RadioNodeList) {
      el.value = String(value);
      for (const r of el) if (r.checked) fire(r);
      return;
    }
    if (el.tagName === 'SELECT' && el.multiple) {
      const wanted = new Set((Array.isArray(value) ? value : [value]).map(String));
      for (const o of el.options) o.selected = wanted.has(o.value);
    } else if (el.type === 'checkbox') {
      el.checked = value === true || value === 'true' || value === 'on';
    } else {
      el.value = value === null || value === undefined ? '' : String(value);
    }
    fire(el);
  };

  const submitButtonOf = (form) => [...form.elements].find((el) => el.type === 'submit') || null;

  const executeDeclarative = (form, toolName) => (input, { signal }) =>
    new Promise((resolve, reject) => {
      validateDeclarativeInput(form, input);
      for (const [name, value] of Object.entries(input)) fillField(form, name, value);
      const button = submitButtonOf(form);
      form.classList.add('tool-form-active');
      if (button) { button.classList.add('tool-submit-active'); button.focus(); }
      fireWindowEvent('toolactivated', { toolName });
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        form.classList.remove('tool-form-active');
        if (button) button.classList.remove('tool-submit-active');
        form.removeEventListener('submit', onSubmit, true);
        form.removeEventListener('reset', onReset);
        fn(value);
      };
      const onReset = () => finish(reject, domError('Tool execution cancelled by a form reset', 'UnknownError'));
      const onSubmit = (ev) => {
        let responded = null;
        Object.defineProperty(ev, 'agentInvoked', { value: true, configurable: true });
        Object.defineProperty(ev, 'respondWith', { configurable: true, value: (promise) => { responded = Promise.resolve(promise); } });
        setTimeout(() => {
          if (!ev.defaultPrevented) { finish(resolve, null); return; } // navigation
          if (!responded) { finish(reject, domError("The site has a programming error: it called preventDefault() on the 'submit' event, without also calling respondWith() with the tool result", 'UnknownError')); return; }
          responded.then((v) => finish(resolve, serializeResult(v)), (e) => { console.error('WebMCP tool execution failed:', e); finish(reject, domError('Tool was executed but the invocation failed. For example, the script function threw an error', 'UnknownError')); });
        }, 0);
      };
      form.addEventListener('submit', onSubmit, true);
      form.addEventListener('reset', onReset);
      signal.addEventListener('abort', () => finish(reject, signal.reason), { once: true });
      if (!form.hasAttribute('toolautosubmit')) return;
      if (!form.noValidate) {
        const invalid = [...form.elements].find((el) => el.name && !el.disabled && !el.checkValidity());
        if (invalid) { finish(reject, domError(`Form validation failed: ${invalid.name}: ${invalid.validationMessage}.`, 'UnknownError')); return; }
      }
      form.requestSubmit(button || undefined);
    });

  const declared = new WeakMap(); // form -> AbortController

  const unregisterForm = (form) => {
    const controller = declared.get(form);
    if (controller) { declared.delete(form); controller.abort(); }
  };

  const registerForm = (form) => {
    const name = form.getAttribute('toolname');
    const description = form.getAttribute('tooldescription');
    unregisterForm(form);
    if (!name || !description) return;
    const controller = new AbortController();
    declared.set(form, controller);
    (nativeMC || shim).registerTool({ name, description, inputSchema: synthesizeSchema(form), execute: executeDeclarative(form, name) }, { signal: controller.signal })
      .catch((e) => console.warn('declarative tool not registered:', name, e.message));
  };

  const scanForms = (root) => {
    if (root.matches && root.matches('form[toolname]')) registerForm(root);
    if (root.querySelectorAll) root.querySelectorAll('form[toolname]').forEach(registerForm);
  };

  /** Native browsers that ship only the imperative API (no declarative forms) get the forms registered for them. */
  const polyfillDeclarativeOnNative = async () => {
    const forms = [...document.querySelectorAll('form[toolname]')];
    if (!forms.length) return;
    const known = new Set((await nativeMC.getTools()).map((t) => t.name));
    const missing = forms.filter((f) => f.getAttribute('toolname') && !known.has(f.getAttribute('toolname')));
    if (missing.length === forms.length) missing.forEach(registerForm);
  };

  if (nativeMC) {
    const start = () => { polyfillDeclarativeOnNative().catch(() => {}); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  } else {
    const start = () => {
      scanForms(document);
      new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === 'attributes') { if (m.target.tagName === 'FORM') registerForm(m.target); continue; }
          m.addedNodes.forEach((n) => { if (n.nodeType === 1) scanForms(n); });
          m.removedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            if (n.matches('form[toolname]')) unregisterForm(n);
            n.querySelectorAll && n.querySelectorAll('form[toolname]').forEach(unregisterForm);
          });
        }
      }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['toolname', 'tooldescription'] });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  // ------------------------------------------------------------- facade
  let lastFromOrigins = [];

  const normalizeNative = (tool) => {
    const schema = tool.inputSchema;
    return {
      name: tool.name,
      title: tool.title || '',
      description: tool.description,
      inputSchema: typeof schema === 'string' ? (schema ? JSON.parse(schema) : undefined) : schema,
      window: tool.window,
      origin: tool.origin,
      annotations: tool.annotations || null,
    };
  };

  const mc = {
    get native() { return !!nativeMC; },
    registerTool: (tool, options) => (nativeMC ? nativeMC.registerTool(tool, options) : shim.registerTool(tool, options)),
    async getTools(options = {}) {
      const tools = nativeMC ? (await nativeMC.getTools(options)).map(normalizeNative) : await shim.getTools(options);
      if (options.fromOrigins) lastFromOrigins = [...options.fromOrigins]; // remembered for executeTool-by-name
      return tools;
    },
    async executeTool(toolOrName, input = {}, options = {}) {
      let tool = toolOrName;
      if (typeof toolOrName === 'string') {
        const tools = await mc.getTools(lastFromOrigins.length ? { fromOrigins: lastFromOrigins } : {});
        tool = tools.find((t) => t.name === toolOrName);
        if (!tool) throw domError('No tool named ' + toolOrName, 'UnknownError');
      }
      const inputJSON = typeof input === 'string' ? input : JSON.stringify(input);
      if (!nativeMC) return shim.executeTool(tool, inputJSON, options);
      return nativeMC.executeTool(tool, inputJSON, options);
    },
    addEventListener: (...a) => (nativeMC || shimTarget).addEventListener(...a),
    removeEventListener: (...a) => (nativeMC || shimTarget).removeEventListener(...a),
    dispatchEvent: (e) => (nativeMC || shimTarget).dispatchEvent(e),
  };

  if (nativeMC) nativeMC.addEventListener('toolchange', () => fireWindowEvent('mc-toolchange'));

  window.mc = mc;
  window.__agent = {
    tools: (fromOrigins) => mc.getTools(fromOrigins && fromOrigins.length ? { fromOrigins } : {}),
    call: (nameOrTool, input) => mc.executeTool(nameOrTool, input || {}),
  };
  window.MC = {
    get native() { return !!nativeMC; },
    get origins() { return window.__ORIGINS || {}; },
    get isMulti() { return Object.keys(window.__ORIGINS || {}).length > 1; },
    origin: (key) => (window.__ORIGINS && window.__ORIGINS[key]) || window.location.origin,
    ready: () => { window.__appReady = true; },
    whenChild: (iframe, timeoutMs = 8000) =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = async () => {
          const pong = iframe.contentWindow ? await rpc(iframe.contentWindow, { kind: 'ping' }, { timeout: 400 }) : null;
          if (pong && pong.ready) return resolve();
          if (Date.now() > deadline) return reject(new Error('child never ready: ' + (iframe.src || 'iframe')));
          setTimeout(tick, 80);
        };
        tick();
      }),
  };
})();

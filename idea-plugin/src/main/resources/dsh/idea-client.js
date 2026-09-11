/* Native DSH Client extension: contribute slots and tokens; preserve the official conversation. */
window.__ModuleLoader__.load({
  id: '@translate/idea-dsh-bridge',
  factory: (require) => {
    const React = require('react');
    const { Button, Menu, Modal, IconChevronDownOutline14, IconCodeOutline16 } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const MODE_LABELS = { general: '通用', tutor: '助教', custom: '自定义' };
    const STYLES = `
      .idea-dsh-mode-wrap { display:inline-flex; align-items:center; gap:4px; flex:none; min-width:0; }
      .idea-dsh-mode { display:inline-flex; align-items:center; gap:4px; min-height:24px; height:24px; padding:0 7px; font-size:12px; white-space:nowrap; color:var(--dsw-alias-label-secondary); }
      .idea-dsh-mode:hover,.idea-dsh-mode[aria-expanded=true] { color:var(--dsw-alias-label-primary); }
      .idea-dsh-footer { display:flex; align-items:center; justify-content:flex-start; gap:8px; width:100%; min-height:32px; padding:0 10px; border-radius:8px; font-size:13px; color:var(--dsw-alias-label-secondary); }
      .idea-dsh-footer[data-wide=false] { width:32px; padding:0; justify-content:center; }
      .idea-dsh-footer-menu { width:100%; }
      .idea-dsh-prompt-modal { box-sizing:border-box; width:min(520px,calc(100vw - 24px)); max-width:calc(100vw - 24px); }
      .idea-dsh-prompt-body { min-width:0; max-height:calc(100dvh - 150px); overflow:auto; }
      .idea-dsh-prompt { display:block; box-sizing:border-box; width:100%; min-height:168px; max-height:44vh; resize:vertical; padding:10px 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; outline:none; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; line-height:1.6; }
      .idea-dsh-prompt:focus-visible { border-color:var(--dsw-alias-brand-primary); box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent); }
      .idea-dsh-prompt-meta { display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-top:8px; color:var(--dsw-alias-label-secondary); font-size:11px; }
      .idea-dsh-validation,.idea-dsh-error-text { color:var(--dsw-alias-state-error-primary); overflow-wrap:anywhere; white-space:pre-wrap; }
      .idea-dsh-error-text { color:var(--dsw-alias-label-primary); line-height:1.6; font-size:13px; }
      .idea-dsh-dialog-actions { display:flex; justify-content:flex-end; gap:8px; }
      .idea-dsh-status-error { min-width:20px; width:20px; height:22px; padding:0; color:var(--dsw-alias-state-error-primary); font-weight:600; }
      .idea-dsh-busy { width:10px; height:10px; border:1.5px solid var(--dsw-alias-border-l2); border-top-color:var(--dsw-alias-brand-primary); border-radius:50%; animation:idea-dsh-spin .8s linear infinite; }
      @keyframes idea-dsh-spin { to { transform:rotate(360deg); } }
      @media(prefers-reduced-motion:reduce) { .idea-dsh-busy { animation:none; } }
      @container(max-width:300px) { .idea-dsh-mode { padding:0 4px; gap:2px; } }
    `;
    return {
      name: 'idea-dsh-client',
      inject: ['sessions', 'uiWorkspace', 'slots', 'theme'],
      apply(ctx) {
        const clientId = crypto.randomUUID();
        const subscribers = new Set();
        const requests = new Set();
        let stopped = false;
        let running = false;
        let dirty = false;
        let navigationRevision = 0;
        let timer;
        let lastAppearance = '';
        let appearance;
        let removeThemeTokens;
        let savedCustomPrompt = '';
        let view = { host: null, modal: null, error: null, applying: false };
        const getSnapshot = () => view;
        const subscribe = listener => { subscribers.add(listener); return () => subscribers.delete(listener); };
        const update = patch => {
          if (stopped) return;
          view = { ...view, ...patch };
          for (const listener of subscribers) listener();
        };
        const currentSessionId = () => ctx.sessions.list.getSnapshot().current ?? null;
        const useView = () => React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
        const applyAppearance = next => {
          if (!next || typeof next.dark !== 'boolean') return;
          const signature = JSON.stringify(next);
          if (signature === lastAppearance) return;
          lastAppearance = signature;
          appearance = next;
          const mapping = {
            background: ['--dsw-alias-bg-base', '--dsw-specific-sidebar-fill'],
            foreground: ['--dsw-alias-label-primary'], muted: ['--dsw-alias-label-secondary'],
            border: ['--dsw-alias-border-l1'], accent: ['--dsw-alias-brand-primary'],
          };
          const tokens = {};
          for (const [field, names] of Object.entries(mapping)) {
            if (typeof next[field] !== 'string' || !/^#[a-f\d]{6}$/i.test(next[field])) continue;
            for (const name of names) tokens[name] = { light: next[field], dark: next[field] };
          }
          const previous = removeThemeTokens;
          removeThemeTokens = ctx.theme.overrideTokens('@translate/idea-dsh-bridge', tokens);
          previous?.();
          ctx.theme.setTheme(next.dark ? 'dark' : 'light');
        };
        const consumeHost = host => {
          applyAppearance(host.appearance);
          if (host.mode === 'custom' && typeof host.customPrompt === 'string') savedCustomPrompt = host.customPrompt;
          const old = view.host;
          if (!old || old.sessionId !== host.sessionId || old.mode !== host.mode || old.customPrompt !== host.customPrompt
            || JSON.stringify(old.status) !== JSON.stringify(host.status)) update({ host });
        };
        const post = async (path, body) => {
          const controller = new AbortController();
          requests.add(controller);
          try {
            const response = await fetch(path, {
              method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body), signal: controller.signal,
            });
            const data = await response.json();
            if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
            return data;
          } finally { requests.delete(controller); }
        };
        const synchronize = async () => {
          if (stopped) return;
          if (running) { dirty = true; return; }
          dirty = false;
          running = true;
          try {
            const state = await post('/ide-dsh/browser', { clientId, sessionId: currentSessionId(), navigationRevision });
            if (stopped) return;
            consumeHost(state);
            if (state.navigation && state.navigation.revision > navigationRevision) {
              ctx.uiWorkspace.openSession(state.navigation.sessionId);
              navigationRevision = state.navigation.revision;
            }
          } catch (error) {
            // The official connection UI owns reconnect status; avoid another persistent banner.
            if (!stopped) console.debug('[IDE bridge]', error.message);
          } finally {
            running = false;
            if (dirty && !stopped) queueMicrotask(() => { void synchronize(); });
          }
        };
        const changeMode = async (mode, customPrompt, sessionId) => {
          if (view.applying) return false;
          update({ applying: true, error: null });
          try {
            const result = await post('/ide-dsh/action', { action: 'mode', sessionId, mode, customPrompt });
            if (stopped) return false;
            if (mode === 'custom') savedCustomPrompt = customPrompt;
            consumeHost(result);
            update({ applying: false, modal: null });
            void synchronize();
            return true;
          } catch (error) {
            update({ applying: false, error: error.message || '模式未能切换，请重试。' });
            return false;
          }
        };
        const runIdeAction = async action => {
          try {
            await post('/ide-dsh/action', { action });
            update({ error: null, modal: null });
          } catch (error) { update({ error: error.message || '操作未能完成，请重试。' }); }
        };
        const selectItem = id => {
          const sessionId = currentSessionId();
          if (id === 'custom' || id === 'edit-prompt') {
            update({ modal: { type: 'prompt', sessionId, initial: savedCustomPrompt }, error: null });
          } else if (id === 'general' || id === 'tutor') {
            void changeMode(id, savedCustomPrompt, sessionId);
          } else if (id === 'show-error') {
            update({ modal: { type: 'error' } });
          } else if (['settings', 'restart', 'retry'].includes(id)) {
            void runIdeAction(id);
          }
        };
        function ModeMenu({ footer = false, wide = false, sessionId }) {
          const state = useView();
          const [open, setOpen] = React.useState(false);
          const host = state.host;
          const id = footer ? currentSessionId() : sessionId;
          const known = host && (host.sessionId ?? null) === (id ?? null);
          const selectedMode = known ? host.mode : null;
          const status = host?.status;
          const error = state.error || (status?.kind === 'error' ? status.message : null);
          const busy = state.applying || status?.kind === 'busy';
          const modeItems = [
            { id: 'general', label: '通用', disabled: state.applying },
            { id: 'tutor', label: '助教', disabled: state.applying },
            { id: 'custom', label: '自定义…', disabled: state.applying },
            { type: 'separator', id: 'prompt-divider' },
            { id: 'edit-prompt', label: '编辑自定义提示词…', disabled: state.applying },
          ];
          const items = footer ? [
            { type: 'label', id: 'mode-heading', text: id == null ? '新会话默认模式' : '当前会话模式' }, ...modeItems,
            { type: 'separator', id: 'runtime-divider' },
            { id: 'settings', label: 'IDE 运行设置…' }, { id: 'restart', label: '重启 Agent' },
            ...(status?.queued > 0 ? [{ id: 'retry', label: '重试待发送选区' }] : []),
            ...(error ? [{ id: 'show-error', label: '查看待处理问题' }] : []),
          ] : modeItems;
          const trigger = h(Button, {
            variant: 'ghost', size: 'sm', className: footer ? 'idea-dsh-footer' : 'idea-dsh-mode',
            'data-wide': footer ? wide : undefined,
            'aria-label': footer ? 'IDE 助手' : `Agent 模式：${MODE_LABELS[selectedMode] || '加载中'}`,
            'aria-haspopup': 'menu', 'aria-expanded': open, title: footer ? 'IDE 助手' : undefined,
            disabled: !host || state.applying, onClick: () => setOpen(value => !value),
          }, ...(footer
            ? [h(IconCodeOutline16, { key: 'icon', size: 16 }), wide ? h('span', { key: 'label' }, 'IDE 助手') : null]
            : [h('span', { key: 'label' }, MODE_LABELS[selectedMode] || '模式'), h(IconChevronDownOutline14, { key: 'chevron', size: 12 })]));
          return h('span', { className: footer ? 'idea-dsh-footer-menu' : 'idea-dsh-mode-wrap' },
            h(Menu, {
              open, anchor: trigger, items, selectedId: selectedMode ?? undefined,
              onSelect: item => { setOpen(false); selectItem(item); }, onClose: () => setOpen(false),
              side: 'top', align: 'start', portal: true, compact: true, autoFocus: true,
              className: footer ? 'idea-dsh-footer-menu' : undefined,
            }),
            !footer && busy ? h('span', { className: 'idea-dsh-busy', role: 'status', 'aria-label': status?.message || '正在切换模式' }) : null,
            !footer && error ? h(Button, {
              variant: 'ghost', size: 'sm', className: 'idea-dsh-status-error',
              'aria-label': '查看待处理问题', title: '查看待处理问题', onClick: () => update({ modal: { type: 'error' } }),
            }, '!') : null,
          );
        }
        function PromptModal({ modal, error, applying }) {
          const [text, setText] = React.useState(modal.initial);
          const trimmed = text.trim();
          const validation = trimmed.length > 16000 ? '提示词最多 16,000 字符。' : null;
          const close = () => { if (!applying) update({ modal: null, error: null }); };
          return h(Modal, {
            open: true, onClose: close, title: '自定义模式', closeLabel: '关闭',
            description: '定义这个模式下 Agent 的工作方式。', className: 'idea-dsh-prompt-modal', contentClassName: 'idea-dsh-prompt-body',
            footer: h('div', { className: 'idea-dsh-dialog-actions' },
              h(Button, { variant: 'ghost', size: 'sm', onClick: close, disabled: applying }, '取消'),
              h(Button, {
                variant: 'primary', size: 'sm', disabled: applying || !trimmed || Boolean(validation),
                onClick: () => { void changeMode('custom', trimmed, modal.sessionId); },
              }, applying ? '正在应用…' : '保存并启用'),
            ),
          }, h('textarea', {
            className: 'idea-dsh-prompt', value: text, rows: 8, autoFocus: true, 'aria-label': '自定义模式提示词',
            placeholder: '例如：作为 Java 助教，先讲清整体意图，再结合源码解释关键设计；用小例子帮我检验理解。',
            onChange: event => setText(event.target.value), disabled: applying,
          }), h('div', { className: 'idea-dsh-prompt-meta' },
            h('span', null, modal.sessionId == null ? '用于之后创建的会话' : '应用到打开编辑框时的会话'),
            h('span', null, `${trimmed.length.toLocaleString()} / 16,000`),
          ), validation || error ? h('p', { className: 'idea-dsh-validation', role: 'alert' }, validation || error) : null);
        }
        function Overlays() {
          const state = useView();
          const status = state.host?.status;
          return h(React.Fragment, null, h('style', null, STYLES),
            state.modal?.type === 'prompt' ? h(PromptModal, {
              key: `${state.modal.sessionId ?? 'default'}:${state.modal.initial}`,
              modal: state.modal, error: state.error, applying: state.applying,
            }) : null,
            state.modal?.type === 'error' ? h(Modal, {
              open: true, onClose: () => update({ modal: null }), title: '待处理问题', closeLabel: '关闭',
              className: 'idea-dsh-prompt-modal', contentClassName: 'idea-dsh-prompt-body',
              footer: h('div', { className: 'idea-dsh-dialog-actions' },
                h(Button, { variant: 'ghost', size: 'sm', onClick: () => { void runIdeAction('settings'); } }, '运行设置'),
                status?.queued > 0 ? h(Button, { variant: 'primary', size: 'sm', onClick: () => { void runIdeAction('retry'); } }, '重试发送') : null,
              ),
            }, h('p', { className: 'idea-dsh-error-text' }, state.error || status?.message || '问题已解决。')) : null,
          );
        }
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left', id: 'idea-dsh-mode', order: 40,
        }, ModeMenu));
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'idea-dsh-actions', order: 40,
        }, props => h(ModeMenu, { ...props, footer: true })));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'idea-dsh-dialogs', order: 40,
        }, Overlays));
        ctx.on('theme/change', () => {
          if (appearance && ctx.theme.getTheme().active.colorScheme !== (appearance.dark ? 'dark' : 'light')) {
            ctx.theme.setTheme(appearance.dark ? 'dark' : 'light');
          }
        });
        ctx.effect(() => {
          const dispose = ctx.sessions.list.subscribe(() => { void synchronize(); });
          timer = setInterval(() => { void synchronize(); }, 700);
          void synchronize();
          return () => {
            stopped = true; clearInterval(timer); dispose(); removeThemeTokens?.();
            for (const request of requests) request.abort();
            requests.clear(); subscribers.clear();
          };
        }, 'idea-dsh: active IDE session and appearance');
      },
    };
  },
});

/* Native DSH Client extension: contribute slots and tokens; preserve the official conversation. */
window.__ModuleLoader__.load({
  id: '@translate/idea-dsh-bridge',
  factory: (require) => {
    const React = require('react');
    const { Button, Input, Menu, Modal, IconChevronDownOutline14, IconCodeOutline16 } = require('@deepseek-ai/dsh-client-ui-primitives');
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
      .idea-dsh-prompt { display:block; box-sizing:border-box; width:100%; min-height:84px; max-height:28vh; resize:vertical; padding:10px 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; outline:none; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; line-height:1.6; }
      .idea-dsh-prompt:focus-visible { border-color:var(--dsw-alias-brand-primary); box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent); }
      .idea-dsh-prompt-meta { display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-top:8px; color:var(--dsw-alias-label-secondary); font-size:11px; }
      .idea-dsh-validation,.idea-dsh-error-text { color:var(--dsw-alias-state-error-primary); overflow-wrap:anywhere; white-space:pre-wrap; }
      .idea-dsh-error-text { color:var(--dsw-alias-label-primary); line-height:1.6; font-size:13px; }
      .idea-dsh-dialog-actions { display:flex; justify-content:flex-end; gap:8px; }
      .idea-dsh-field-label { display:block; margin:0 0 8px; color:var(--dsw-alias-label-primary); font-size:12px; font-weight:500; }
      .idea-dsh-skills-section { margin-top:18px; min-width:0; }
      .idea-dsh-skills-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
      .idea-dsh-skills-heading .idea-dsh-field-label { margin:0; }
      .idea-dsh-skill-count,.idea-dsh-skill-hint { color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1.5; }
      .idea-dsh-skills-search { display:flex; width:100%; min-width:0; }
      .idea-dsh-skills-anchor { display:flex; align-items:center; gap:8px; min-width:0; }
      .idea-dsh-skills-anchor > :first-child { flex:1; min-width:0; }
      .idea-dsh-skills-picker { display:block; width:100%; }
      .idea-dsh-skill-option { display:flex; flex-direction:column; gap:3px; min-width:0; max-width:min(320px,calc(100vw - 96px)); white-space:normal; }
      .idea-dsh-skill-option-name { font-size:12px; color:var(--dsw-alias-label-primary); overflow-wrap:anywhere; }
      .idea-dsh-skill-option-description { font-size:11px; line-height:1.45; color:var(--dsw-alias-label-secondary); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; }
      .idea-dsh-selected-skills { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
      .idea-dsh-skill-chip { display:inline-flex; gap:6px; max-width:100%; height:auto; min-height:26px; padding:3px 8px; font-size:11px; }
      .idea-dsh-skill-chip span:first-child { min-width:0; overflow-wrap:anywhere; white-space:normal; }
      .idea-dsh-skill-chip[data-unavailable=true] { color:var(--dsw-alias-state-error-primary); }
      .idea-dsh-skills-notice { margin:8px 0 0; font-size:11px; line-height:1.5; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
      .idea-dsh-config-loading { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; min-height:180px; color:var(--dsw-alias-label-secondary); font-size:13px; text-align:center; overflow-wrap:anywhere; }
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
          const old = view.host;
          if (!old || old.sessionId !== host.sessionId || old.mode !== host.mode || old.customPrompt !== host.customPrompt
            || JSON.stringify(old.skillNames) !== JSON.stringify(host.skillNames)
            || JSON.stringify(old.customMode) !== JSON.stringify(host.customMode)
            || JSON.stringify(old.status) !== JSON.stringify(host.status)) update({ host });
        };
        const post = async (path, body, signal) => {
          const controller = new AbortController();
          requests.add(controller);
          const abort = () => controller.abort();
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
          try {
            const response = await fetch(path, {
              method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body), signal: controller.signal,
            });
            const data = await response.json();
            if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
            return data;
          } finally { signal?.removeEventListener('abort', abort); requests.delete(controller); }
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
        const changeMode = async (mode, customPrompt, sessionId, skillNames = []) => {
          if (view.applying) return false;
          update({ applying: true, error: null });
          try {
            const result = await post('/ide-dsh/action', {
              action: 'mode', sessionId, mode,
              ...(mode === 'custom' ? { customPrompt, skillNames } : {}),
            });
            if (stopped) return false;
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
            update({ modal: { type: 'prompt', sessionId }, error: null });
          } else if (id === 'general' || id === 'tutor') {
            void changeMode(id, undefined, sessionId);
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
          const boundSkills = known && Array.isArray(host.skillNames) ? host.skillNames : [];
          const status = host?.status;
          const error = state.error || (status?.kind === 'error' ? status.message : null);
          const busy = state.applying || status?.kind === 'busy';
          const modeItems = [
            { id: 'general', label: '通用', disabled: state.applying },
            { id: 'tutor', label: h('span', { className: 'idea-dsh-skill-option' },
              h('span', { className: 'idea-dsh-skill-option-name' }, '助教'),
              h('span', { className: 'idea-dsh-skill-option-description' }, '内置 ide-code-tutor')), disabled: state.applying },
            { id: 'custom', label: '自定义…', disabled: state.applying },
            { type: 'separator', id: 'prompt-divider' },
            { id: 'edit-prompt', label: '配置角色与 Skills…', disabled: state.applying },
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
            'aria-haspopup': 'menu', 'aria-expanded': open,
            title: footer ? 'IDE 助手' : boundSkills.length ? `Skills：${boundSkills.join('、')}` : undefined,
            disabled: !host || state.applying, onClick: () => setOpen(value => !value),
          }, ...(footer
            ? [h(IconCodeOutline16, { key: 'icon', size: 16 }), wide ? h('span', { key: 'label' }, 'IDE 助手') : null]
            : [h('span', { key: 'label' }, `${MODE_LABELS[selectedMode] || '模式'}${boundSkills.length ? ` · ${boundSkills.length}` : ''}`),
              h(IconChevronDownOutline14, { key: 'chevron', size: 12 })]));
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
          const [revision, setRevision] = React.useState(0);
          const [configuration, setConfiguration] = React.useState({ phase: 'loading', value: null, error: null });
          React.useEffect(() => {
            const controller = new AbortController();
            setConfiguration({ phase: 'loading', value: null, error: null });
            void post('/ide-dsh/action', { action: 'mode-config', sessionId: modal.sessionId }, controller.signal).then(result => {
              if (controller.signal.aborted) return;
              const value = result.customMode;
              if (!value || typeof value.customPrompt !== 'string' || !Array.isArray(value.skillNames)
                || !value.skillNames.every(name => typeof name === 'string')) {
                throw new Error('自定义模式配置格式无效，请重试。');
              }
              setConfiguration({ phase: 'ready', value, error: null });
            }).catch(failure => {
              if (!controller.signal.aborted) setConfiguration({ phase: 'error', value: null, error: failure.message || '暂时无法读取自定义模式。' });
            });
            return () => controller.abort();
          }, [modal.sessionId, revision]);
          // Mount the editor only after this exact target has loaded. Later host polls never hydrate over edits.
          if (configuration.phase === 'ready') return h(PromptEditor, {
            modal: { ...modal, initial: configuration.value.customPrompt, skillNames: configuration.value.skillNames }, error, applying,
          });
          return h(Modal, {
            open: true, onClose: () => update({ modal: null, error: null }), title: '自定义模式', closeLabel: '关闭',
            className: 'idea-dsh-prompt-modal', contentClassName: 'idea-dsh-prompt-body',
            footer: h('div', { className: 'idea-dsh-dialog-actions' },
              h(Button, { variant: 'ghost', size: 'sm', onClick: () => update({ modal: null, error: null }) }, '取消'),
            ),
          }, h('div', { className: 'idea-dsh-config-loading', role: configuration.phase === 'error' ? 'alert' : 'status' },
            configuration.phase === 'loading' ? h('span', { className: 'idea-dsh-busy', 'aria-hidden': true }) : null,
            h('span', null, configuration.phase === 'loading'
              ? modal.sessionId == null ? '正在读取默认自定义模式…' : '正在读取此会话的自定义模式…'
              : configuration.error),
            configuration.phase === 'error' ? h(Button, {
              variant: 'outline', size: 'sm', onClick: () => setRevision(value => value + 1),
            }, '重新读取') : null,
          ));
        }
        function PromptEditor({ modal, error, applying }) {
          const [text, setText] = React.useState(modal.initial);
          const [selected, setSelected] = React.useState(() => [...new Set(modal.skillNames)]);
          const [query, setQuery] = React.useState('');
          const [pickerOpen, setPickerOpen] = React.useState(false);
          const [focusChoices, setFocusChoices] = React.useState(false);
          const [revision, setRevision] = React.useState(0);
          const [catalog, setCatalog] = React.useState({ phase: 'loading', items: [], error: null });
          React.useEffect(() => {
            const controller = new AbortController();
            setCatalog({ phase: 'loading', items: [], error: null });
            void post('/ide-dsh/action', { action: 'skills', sessionId: modal.sessionId }, controller.signal).then(result => {
              if (controller.signal.aborted) return;
              if (!Array.isArray(result.items)) throw new Error('Skills 列表格式无效，请重试。');
              setCatalog({ phase: 'ready', items: result.items, error: null });
            }).catch(failure => {
              if (!controller.signal.aborted) setCatalog({ phase: 'error', items: [], error: failure.message || 'Skills 暂时无法加载。' });
            });
            return () => controller.abort();
          }, [modal.sessionId, revision]);
          const trimmed = text.trim();
          const unavailable = catalog.phase === 'ready'
            ? selected.filter(name => !catalog.items.some(item => item.name === name && item.userInvocable !== false)) : [];
          const validation = trimmed.length > 16000 ? '角色说明最多 16,000 字符。'
            : selected.length > 8 ? '最多关联 8 个 Skills，请移除多余项。'
              : unavailable.length ? `以下 Skills 已不可用，请移除后保存：${unavailable.join('、')}` : null;
          const canSave = !applying && Boolean(trimmed || selected.length) && !validation
            && (selected.length === 0 || catalog.phase === 'ready');
          const close = () => { if (!applying) update({ modal: null, error: null }); };
          const toggleSkill = name => {
            setSelected(previous => previous.includes(name) ? previous.filter(value => value !== name)
              : previous.length < 8 ? [...previous, name] : previous);
          };
          const search = query.trim().toLowerCase();
          const candidates = catalog.items.filter(item => !search
            || `${item.name} ${item.description || ''} ${item.provider || ''}`.toLowerCase().includes(search));
          const skillItems = candidates.map(item => ({
            id: item.name,
            label: h('span', { className: 'idea-dsh-skill-option' },
              h('span', { className: 'idea-dsh-skill-option-name' }, item.name),
              h('span', { className: 'idea-dsh-skill-option-description' }, item.description || '未提供说明'),
              item.userInvocable === false ? h('span', { className: 'idea-dsh-skill-hint' }, '不可手动启用')
                : item.provider ? h('span', { className: 'idea-dsh-skill-hint' }, item.provider) : null,
            ),
            disabled: applying || item.userInvocable === false || (!selected.includes(item.name) && selected.length >= 8),
          }));
          if (skillItems.length === 0) skillItems.push({
            type: 'label', id: 'empty', text: catalog.phase === 'loading' ? '正在读取 Skills…'
              : catalog.phase === 'error' ? 'Skills 暂时无法加载' : query.trim() ? '没有匹配的 Skills' : '当前项目还没有可用 Skills',
          });
          return h(Modal, {
            open: true, onClose: close, title: '自定义模式', closeLabel: '关闭',
            description: '用简短角色说明配合 Skills，定义 Agent 的工作方式。',
            className: 'idea-dsh-prompt-modal', contentClassName: 'idea-dsh-prompt-body',
            footer: h('div', { className: 'idea-dsh-dialog-actions' },
              h(Button, { variant: 'ghost', size: 'sm', onClick: close, disabled: applying }, '取消'),
              h(Button, {
                variant: 'primary', size: 'sm', disabled: !canSave,
                onClick: () => { void changeMode('custom', trimmed, modal.sessionId, selected); },
              }, applying ? '正在应用…' : '保存并启用'),
            ),
          }, h('label', { className: 'idea-dsh-field-label', htmlFor: 'idea-dsh-role-prompt' }, '角色说明'),
          h('textarea', {
            id: 'idea-dsh-role-prompt', className: 'idea-dsh-prompt', value: text, rows: 3, autoFocus: true,
            'aria-label': '自定义模式提示词', placeholder: '例如：作为 Java 助教，用小例子帮助我理解代码；先解释思路，再讨论实现。',
            onChange: event => setText(event.target.value), disabled: applying,
          }), h('div', { className: 'idea-dsh-prompt-meta' },
            h('span', null, '已选 Skills 时可留空'),
            h('span', null, `${trimmed.length.toLocaleString()} / 16,000`),
          ), h('section', { className: 'idea-dsh-skills-section', 'aria-label': '关联 Skills' },
            h('div', { className: 'idea-dsh-skills-heading' },
              h('label', { className: 'idea-dsh-field-label', htmlFor: 'idea-dsh-skill-search' }, '关联 Skills'),
              h('span', { className: 'idea-dsh-skill-count' }, `${selected.length} / 8`),
            ),
            h(Menu, {
              open: pickerOpen, selectedIds: selected, items: skillItems, className: 'idea-dsh-skills-picker',
              portal: true, compact: true, side: 'bottom', align: 'start', autoFocus: focusChoices,
              onClose: () => setPickerOpen(false), onSelect: toggleSkill,
              anchor: h('div', { className: 'idea-dsh-skills-anchor' },
                h(Input, {
                  id: 'idea-dsh-skill-search', className: 'idea-dsh-skills-search', value: query,
                  placeholder: '搜索 Skills', 'aria-label': '搜索 Skills', 'aria-expanded': pickerOpen,
                  onFocus: () => { setFocusChoices(false); setPickerOpen(true); },
                  onChange: event => { setQuery(event.target.value); setFocusChoices(false); setPickerOpen(true); },
                  onKeyDown: event => {
                    if (event.key === 'ArrowDown') { event.preventDefault(); setFocusChoices(true); setPickerOpen(true); }
                  }, disabled: applying,
                }),
                h(Button, {
                  variant: 'ghost', size: 'sm', 'aria-label': pickerOpen ? '收起 Skills 列表' : '展开 Skills 列表',
                  'aria-expanded': pickerOpen, disabled: applying,
                  onClick: () => { setFocusChoices(true); setPickerOpen(value => !value); },
                }, h(IconChevronDownOutline14, { size: 14 })),
              ),
            }),
            selected.length ? h('div', { className: 'idea-dsh-selected-skills', 'aria-label': '已选择的 Skills' },
              ...selected.map(name => h(Button, {
                key: name, variant: 'outline', size: 'sm', className: 'idea-dsh-skill-chip',
                'data-unavailable': unavailable.includes(name), 'aria-label': `移除 Skill ${name}`,
                disabled: applying, onClick: () => toggleSkill(name),
              }, h('span', null, name), h('span', { 'aria-hidden': true }, '×'))),
            ) : h('p', { className: 'idea-dsh-skills-notice' }, '按需选择，最多 8 个。'),
            catalog.phase === 'loading' ? h('p', { className: 'idea-dsh-skills-notice', role: 'status' }, '正在读取项目 Skills…') : null,
            catalog.phase === 'error' ? h('div', { className: 'idea-dsh-skills-notice', role: 'alert' },
              h('span', null, catalog.error), ' ',
              h(Button, { variant: 'ghost', size: 'sm', disabled: applying, onClick: () => setRevision(value => value + 1) }, '重试'),
            ) : null,
            catalog.phase === 'ready' && !catalog.items.length ? h('p', { className: 'idea-dsh-skills-notice' }, '当前项目还没有可用 Skills，可先填写角色说明。') : null,
          ), h('p', { className: 'idea-dsh-skills-notice' }, modal.sessionId == null ? '用于之后创建的会话' : '应用到打开编辑框时的会话'),
          validation || error ? h('p', { className: 'idea-dsh-validation', role: 'alert' }, validation || error) : null);
        }
        function Overlays() {
          const state = useView();
          const status = state.host?.status;
          return h(React.Fragment, null, h('style', null, STYLES),
            state.modal?.type === 'prompt' ? h(PromptModal, {
              key: state.modal.sessionId ?? 'default',
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

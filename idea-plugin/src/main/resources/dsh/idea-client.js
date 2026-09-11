/* A native DSH Client plugin. The official module loader owns this factory. */
window.__ModuleLoader__.load({
  id: '@translate/idea-dsh-bridge',
  factory: () => ({
    name: 'idea-dsh-client',
    inject: ['sessions', 'uiWorkspace'],
    apply(ctx) {
      const clientId = crypto.randomUUID();
      let stopped = false;
      let running = false;
      let dirty = false;
      let navigationRevision = 0;
      let timer;
      let request;
      const synchronize = async () => {
        if (stopped) return;
        if (running) { dirty = true; return; }
        dirty = false;
        running = true;
        request = new AbortController();
        try {
          const response = await fetch('/ide-dsh/browser', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientId, sessionId: ctx.sessions.list.getSnapshot().current ?? null, navigationRevision }),
            signal: request.signal,
          });
          if (!response.ok) throw new Error(`IDE bridge: HTTP ${response.status}`);
          const state = await response.json();
          if (!stopped && state.navigation && state.navigation.revision > navigationRevision) {
            ctx.uiWorkspace.openSession(state.navigation.sessionId);
            navigationRevision = state.navigation.revision;
          }
        } catch (error) {
          if (!stopped) console.debug('[IDE bridge]', error.message);
        } finally {
          running = false;
          if (dirty && !stopped) queueMicrotask(() => { void synchronize(); });
        }
      };
      ctx.effect(() => {
        const dispose = ctx.sessions.list.subscribe(() => { void synchronize(); });
        timer = setInterval(() => { void synchronize(); }, 700);
        void synchronize();
        return () => { stopped = true; clearInterval(timer); request?.abort(); dispose(); };
      }, 'idea-dsh: active IDE session');
    },
  }),
});

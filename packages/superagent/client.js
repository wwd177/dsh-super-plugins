window.__ModuleLoader__.load({
  id: '@local/dsh-superagent-menu',
  factory() {
    return {
      inject: ['commandUi', 'sessions', 'uiConversation'],
      apply(ctx) {
        ctx.commandUi.register({
          name: 'superagent',
          label: () => 'SuperAgent 协作与交付',
          description: () => '加入工作流，填写任务后发送',
          available: session => ctx.sessions.scope(session.sessionId) !== undefined && ctx.sessions.subagentAddress(session.sessionId) === undefined,
          ui: {
            kind: 'action',
            run(session) {
              const actx = ctx.sessions.scope(session.sessionId);
              if (!actx) return;
              const input = actx.get('conversation').input.for(actx);
              const span = { ...input.actions.captureInsertion(), start: 0, end: 0 };
              if (input.actions.insertText('/superagent-workflow ', span)) input.focus();
            },
          },
        });
      },
    };
  },
});

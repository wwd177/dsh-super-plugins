window.__ModuleLoader__.load({
  id: '@local/dsh-super-teams',
  factory(require) {
    const WORKBENCH_KIND = 'superagent-workbench';
    const WORKBENCH_ID = '@local/dsh-super-teams';
    const OPEN_EVENT = 'dsh-superagent:open-workbench';
    const FOCUS_TEAM_EVENT = 'dsh-superagent:focus-team';
    // Strict per-session team focus map prevents session B from hijacking session A's mounted workbench.
    const lastTeamBySession = new Map();
    let lastUnscopedTeam = '';

    function rememberTeamForSession(sessionId, teamId) {
      if (!teamId) return;
      if (sessionId) lastTeamBySession.set(sessionId, teamId);
      else lastUnscopedTeam = teamId;
    }

    function readTeamForSession(sessionId) {
      if (sessionId) return lastTeamBySession.get(sessionId) || '';
      return lastUnscopedTeam || '';
    }

    function extractSessionId(raw) {
      if (typeof raw === 'string' && raw.trim()) return raw.trim();
      if (raw && typeof raw === 'object') {
        if (typeof raw.sessionId === 'string' && raw.sessionId.trim()) return raw.sessionId.trim();
        if (typeof raw.id === 'string' && raw.id.trim()) return raw.id.trim();
      }
      return null;
    }

    function matchesTargetSession(mySessionId, targetSessionId) {
      const mySid = extractSessionId(mySessionId);
      const targetSid = extractSessionId(targetSessionId);
      if (targetSid) return Boolean(mySid) && mySid === targetSid;
      return !mySid;
    }

    function safeRequire(id) {
      try { return typeof require === 'function' ? require(id) : null; }
      catch { return null; }
    }

    function resolveEngineBase() {
      const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI
        ? document.baseURI
        : (typeof location !== 'undefined' ? location.href : 'http://127.0.0.1/');
      return new URL('superagent-engine', base).href.replace(/\/+$/, '');
    }

    function createWorkbenchComponent(React) {
      if (!React) return null;
      const h = React.createElement;
      const useEffect = React.useEffect;
      const useRef = React.useRef;

      function WorkbenchIcon(props) {
        const size = (props && props.size) || 16;
        return h('svg', {
          width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
          h('rect', { x: 1.8, y: 2.2, width: 4.6, height: 4.2, rx: 1 }),
          h('rect', { x: 9.6, y: 2.2, width: 4.6, height: 4.2, rx: 1 }),
          h('rect', { x: 5.7, y: 9.6, width: 4.6, height: 4.2, rx: 1 }),
          h('path', { d: 'M4.1 6.4v1.5h7.8V6.4M8 7.9v1.7' })
        );
      }

      function WorkbenchHost(props) {
        const hostRef = useRef(null);
        const controllerRef = useRef(null);
        const sessionId = extractSessionId(props?.sessionId) ?? extractSessionId(props?.scope?.sessionId) ?? null;
        const sessionIdRef = useRef(sessionId);
        sessionIdRef.current = sessionId;

        useEffect(() => {
          const el = hostRef.current;
          if (!el) return undefined;
          let cancelled = false;
          let retryTimer = null;
          const apiBase = resolveEngineBase();
          const shadow = el.shadowRoot || el.attachShadow({ mode: 'open' });

          const showFailure = (message, attempt) => {
            if (cancelled || !el.shadowRoot) return;
            const errBox = document.createElement('div');
            errBox.style.padding = '16px';
            errBox.style.font = '12px/1.6 sans-serif';
            errBox.style.color = '#d65d55';
            const msgEl = document.createElement('div');
            msgEl.textContent = attempt < 2
              ? `团队工作台正在重连（${attempt + 1}/2）：${message}`
              : `团队工作台加载失败：${message}`;
            errBox.appendChild(msgEl);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = '重新加载';
            btn.style.marginTop = '10px';
            btn.style.padding = '4px 10px';
            btn.style.font = '12px sans-serif';
            btn.style.cursor = 'pointer';
            btn.addEventListener('click', () => {
              if (retryTimer !== null) {
                clearTimeout(retryTimer);
                retryTimer = null;
              }
              mountWorkbench(attempt + 1);
            });
            errBox.appendChild(btn);
            el.shadowRoot.replaceChildren(errBox);
          };

          const mountWorkbench = async (attempt = 0) => {
            try {
              const [cssRes, htmlRes] = await Promise.all([
                fetch(`${apiBase}/style.css`, { cache: 'no-store', credentials: 'same-origin' }),
                fetch(`${apiBase}/template.html`, { cache: 'no-store', credentials: 'same-origin' }),
              ]);
              if (cancelled) return;
              if (!cssRes.ok) throw new Error(`style.css HTTP ${cssRes.status}`);
              if (!htmlRes.ok) throw new Error(`template.html HTTP ${htmlRes.status}`);
              const cssType = (cssRes.headers?.get?.('content-type') || '').toLowerCase();
              if (cssType.includes('text/html')) {
                throw new Error('宿主未挂载 /superagent-engine 路由（返回了 HTML 回退页）');
              }
              const [cssText, htmlText] = await Promise.all([cssRes.text(), htmlRes.text()]);
              if (cancelled) return;
              if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in shadow) {
                const sheet = new CSSStyleSheet();
                sheet.replaceSync(cssText);
                shadow.adoptedStyleSheets = [sheet];
                shadow.innerHTML = htmlText;
              } else {
                shadow.innerHTML = `<link rel="stylesheet" href="${apiBase}/style.css">${htmlText}`;
              }
              const moduleUrl = attempt > 0 ? `${apiBase}/app.js?retry=${attempt}` : `${apiBase}/app.js`;
              const mod = await import(moduleUrl);
              if (cancelled) return;
              const initSid = sessionIdRef.current;
              const ctrl = await mod.mountSuperAgentWorkbench(shadow, {
                apiBase,
                sessionId: initSid,
                teamId: readTeamForSession(initSid),
              });
              if (cancelled) { ctrl.dispose(); return; }
              controllerRef.current = ctrl;
              // Re-apply latest team remembered for this exact session in case focus arrived during async mount.
              const latestSid = sessionIdRef.current;
              if (latestSid && latestSid !== initSid) ctrl.setSessionId?.(latestSid);
              const latestTeam = readTeamForSession(latestSid);
              if (latestTeam) ctrl.selectTeam?.(latestTeam);
            } catch (err) {
              if (cancelled) return;
              const message = String(err?.message || err);
              showFailure(message, attempt);
              if (attempt < 2) {
                if (retryTimer !== null) clearTimeout(retryTimer);
                retryTimer = setTimeout(() => {
                  retryTimer = null;
                  if (!cancelled && !controllerRef.current) mountWorkbench(attempt + 1);
                }, 400 * (attempt + 1));
              }
            }
          };

          mountWorkbench(0);

          const onFocusTeam = ev => {
            const teamId = ev?.detail?.teamId;
            const targetSid = ev?.detail?.sessionId ?? null;
            if (!teamId || !matchesTargetSession(sessionIdRef.current, targetSid)) return;
            rememberTeamForSession(targetSid, teamId);
            controllerRef.current?.selectTeam?.(teamId);
          };
          window.addEventListener(FOCUS_TEAM_EVENT, onFocusTeam);

          return () => {
            cancelled = true;
            if (retryTimer !== null) {
              clearTimeout(retryTimer);
              retryTimer = null;
            }
            window.removeEventListener(FOCUS_TEAM_EVENT, onFocusTeam);
            try { controllerRef.current?.dispose?.(); } catch {}
            controllerRef.current = null;
          };
        }, []);

        useEffect(() => {
          sessionIdRef.current = sessionId;
          if (sessionId) {
            controllerRef.current?.setSessionId?.(sessionId);
            const remembered = readTeamForSession(sessionId);
            if (remembered) controllerRef.current?.selectTeam?.(remembered);
          }
        }, [sessionId]);

        return h('div', {
          ref: hostRef,
          'data-superagent-workbench': '',
          style: { width: '100%', height: '100%', minHeight: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
        });
      }

      return { WorkbenchHost, WorkbenchIcon };
    }

    return {
      inject: ['commandUi', 'sessions', 'uiConversation'],
      apply(ctx) {
        let openInRightSidebar = null;

        const triggerOpenWorkbench = (sessionId, teamId) => {
          const cleanSid = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
          if (teamId) {
            rememberTeamForSession(cleanSid, teamId);
            if (typeof window?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
              window.dispatchEvent(new CustomEvent(FOCUS_TEAM_EVENT, { detail: { sessionId: cleanSid, teamId } }));
            }
          }
          const better = ctx.get?.('betterSidebar');
          const betterMounted = typeof document !== 'undefined' && document.querySelector?.('[data-dsh-better-sidebar]') !== null;
          if (better?.openTab && betterMounted) {
            try {
              better.openTab({
                type: WORKBENCH_KIND,
                id: WORKBENCH_KIND,
                title: '团队工作台',
              }, cleanSid ? { sessionId: cleanSid } : undefined);
              return true;
            } catch {}
          }
          if (typeof openInRightSidebar === 'function') {
            try { return openInRightSidebar(cleanSid); } catch {}
          }
          return false;
        };

        // 1. Register '/super-teams ' draft insertion command in '+' menu
        ctx.commandUi.register({
          name: 'superteams',
          label: () => 'Super Teams',
          description: () => '加入工作流，填写任务后发送',
          available: session => ctx.sessions.scope(session.sessionId) !== undefined && ctx.sessions.subagentAddress(session.sessionId) === undefined,
          ui: {
            kind: 'action',
            run(session) {
              const actx = ctx.sessions.scope(session.sessionId);
              if (!actx) return;
              const input = actx.get('conversation').input.for(actx);
              const span = { ...input.actions.captureInsertion(), start: 0, end: 0 };
              if (input.actions.insertText('/super-teams ', span)) input.focus();
            },
          },
        });

        // 2. Register '打开团队工作台' action in '+' menu (when running in real browser DOM)
        if (typeof window !== 'undefined' && typeof document !== 'undefined') {
          ctx.commandUi.register({
            name: 'superagent-workbench',
            label: () => 'SuperAgent 团队工作台',
            description: () => '在右侧栏打开关键路径波次与验收工作台',
            available: session => ctx.sessions.scope(session.sessionId) !== undefined && ctx.sessions.subagentAddress(session.sessionId) === undefined,
            ui: {
              kind: 'action',
              run(session) {
                triggerOpenWorkbench(session.sessionId, null);
              },
            },
          });
        }

        const ReactMod = safeRequire('react');
        const React = ReactMod?.default || ReactMod;
        const ui = createWorkbenchComponent(React);
        if (!ui || typeof ctx.inject !== 'function') return;

        // 3. Soft-inject into stock DeepSeek Harness Right Sidebar (`sidebarRightTabs` + `slots`)
        ctx.inject(['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'], sctx => {
          const ns = 'superagentWorkbench';
          sctx.effect(() => sctx.locale.register(ns, {
            zh: { label: '团队工作台', desc: 'SuperAgent 关键路径波次编排与客观验收' },
            en: { label: 'Team Workbench', desc: 'SuperAgent wave DAG & verification workbench' },
          }), 'superagent-workbench: locale');

          sctx.effect(() => sctx.sidebarRightTabs.register({
            id: WORKBENCH_ID,
            kind: WORKBENCH_KIND,
            priority: 'plugin',
            keepMounted: true,
            title: () => '团队工作台',
            guide: [{
              id: WORKBENCH_KIND,
              commandId: 'superagent.workbench',
              order: 35,
              title: () => 'SuperAgent 团队工作台',
              description: () => '查看拓扑波次、关键路径、成员进度与快照验收',
              icon: ui.WorkbenchIcon,
            }],
          }), 'superagent-workbench: tab type');

          sctx.effect(() => sctx.slots.inject('sidebar.right.pane.tab', () =>
            sctx.slots.register({
              name: 'sidebar.right.pane.tab',
              key: WORKBENCH_ID,
              locale: ns,
              inject: sessionId => ({ sessionId }),
            }, props => React.createElement(ui.WorkbenchHost, { sessionId: props?.sessionId ?? null }))
          ), 'superagent-workbench: tab body');

          sctx.effect(() => sctx.slots.inject('sidebar.right.pane.tab.title', () =>
            sctx.slots.register({
              name: 'sidebar.right.pane.tab.title',
              key: WORKBENCH_ID,
            }, () => React.createElement('span', null, '团队工作台'))
          ), 'superagent-workbench: tab title');

          openInRightSidebar = sessionId => {
            const activeTarget = sctx.sidebarRight.commandTarget?.(document.activeElement);
            const target = sessionId
              ? (activeTarget?.sessionId === sessionId ? activeTarget : { sessionId, host: 'dock' })
              : activeTarget;
            if (!target) return false;
            sctx.sidebarRight.openTabFromTarget(WORKBENCH_KIND, target);
            if (!sctx.sidebarRight.isExpanded?.()) sctx.sidebarRight.toggleExpanded?.();
            return true;
          };
        });

        // 4. Soft-inject into community `dsh-better-sidebar` when installed
        ctx.inject(['betterSidebar'], bctx => {
          bctx.effect(() => bctx.betterSidebar.registerTab({
            id: WORKBENCH_KIND,
            title: () => '团队工作台',
            description: () => 'SuperAgent 关键路径波次编排与客观验收',
            icon: size => React.createElement(ui.WorkbenchIcon, { size: typeof size === 'number' ? size : 16 }),
            order: 35,
            single: true,
            component: ({ scope }) => React.createElement(ui.WorkbenchHost, { sessionId: scope?.sessionId ?? null }),
          }), 'superagent-workbench: better-sidebar tab');
        });

        // 5. Listen for cross-plugin & host auto-open signals (`engine_team prepare` / `engine_workspace`)
        if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof ctx.effect === 'function') {
          ctx.effect(() => {
            const onCustomOpen = ev => {
              triggerOpenWorkbench(ev?.detail?.sessionId ?? null, ev?.detail?.teamId ?? null);
            };
            window.addEventListener(OPEN_EVENT, onCustomOpen);

            let lastSeq = null;
            let inFlight = false;
            let currentAbort = null;
            let disposed = false;
            const apiBase = resolveEngineBase();
            const poll = async () => {
              if (disposed || inFlight || document.hidden) return;
              inFlight = true;
              const ac = typeof AbortController === 'function' ? new AbortController() : null;
              currentAbort = ac;
              try {
                const cursor = lastSeq === null ? -1 : lastSeq;
                const res = await fetch(`${apiBase}/api/changes?since=${cursor}`, {
                  cache: 'no-store',
                  credentials: 'same-origin',
                  ...(ac ? { signal: ac.signal } : {}),
                });
                if (!res.ok || disposed) return;
                const data = await res.json();
                if (disposed) return;
                if (typeof data?.seq === 'number') {
                  const wasSubscribed = lastSeq !== null;
                  if (lastSeq === null || data.seq > lastSeq) {
                    lastSeq = data.seq;
                  }
                  if (wasSubscribed && Array.isArray(data.items)) {
                    for (const item of data.items) {
                      if (disposed) break;
                      if (item?.event === 'open-workbench') {
                        const targetSid = item.payload?.sessionId ?? null;
                        if (targetSid && typeof ctx.sessions?.scope === 'function' && ctx.sessions.scope(targetSid) === undefined) {
                          continue;
                        }
                        triggerOpenWorkbench(targetSid, item.payload?.teamId ?? null);
                      }
                    }
                  }
                }
              } catch {}
              finally {
                if (currentAbort === ac) currentAbort = null;
                inFlight = false;
              }
            };
            poll();
            const timer = window.setInterval(poll, 1800);

            return () => {
              disposed = true;
              window.clearInterval(timer);
              try { currentAbort?.abort?.(); } catch {}
              window.removeEventListener(OPEN_EVENT, onCustomOpen);
            };
          }, 'superagent-workbench: auto-open listener');
        }
      },
    };
  },
});

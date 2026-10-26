(function registerOpenClawStreamPlugin() {
    const pluginID = 'openclaw-stream';
    const postType = 'custom_openclaw_stream';
    const updateEvent = 'custom_openclaw-stream_update';
    const streamStore = new window.OpenClawStreamState.EventStore();
    let mattermostStore;

    function siteURL() {
        const state = mattermostStore?.getState?.();
        const configuredURL = state?.entities?.general?.config?.SiteURL;
        return (configuredURL || window.location.origin).replace(/\/$/, '');
    }

    function pluginURL(path) {
        return `${siteURL()}/plugins/${pluginID}/v1${path}`;
    }

    async function getJSON(url) {
        const response = await window.fetch(url, {
            credentials: 'same-origin',
            headers: {Accept: 'application/json'},
            cache: 'no-store',
        });
        if (!response.ok) {
            return null;
        }
        return response.json();
    }

    async function readPersistedPost(postID, onRead) {
        try {
            const persisted = await getJSON(`${siteURL()}/api/v4/posts/${encodeURIComponent(postID)}`);
            if (persisted && persisted.id === postID && typeof persisted.message === 'string') {
                onRead(persisted);
            }
        } catch {
            // The post supplied by Mattermost remains the fallback when the REST read fails.
        }
    }

    function StreamPost(props) {
        const React = window.React;
        const post = props.post;
        const [snapshot, setSnapshot] = React.useState(() => streamStore.get(post.id));
        const [persistedPost, setPersistedPost] = React.useState(null);

        React.useEffect(() => {
            let active = true;
            const refreshPersisted = () => readPersistedPost(post.id, (latest) => {
                if (active) {
                    setPersistedPost(latest);
                }
            });
            const refresh = async () => {
                try {
                    const current = await getJSON(pluginURL(`/posts/${encodeURIComponent(post.id)}`));
                    if (!active) {
                        return;
                    }
                    if (current) {
                        streamStore.publish(current);
                        if (current.closed) {
                            await refreshPersisted();
                            return;
                        }
                    } else {
                        streamStore.forget(post.id);
                    }
                } catch {
                    // Keep rendering Mattermost's durable post message.
                }
                await refreshPersisted();
            };
            const onSnapshot = () => {
                const current = streamStore.get(post.id);
                setSnapshot(current);
                if (current?.closed) {
                    void refreshPersisted();
                }
            };
            const unsubscribe = streamStore.subscribe(post.id, onSnapshot);
            const unregisterRefresh = streamStore.registerRefresh(() => {
                void refresh();
            });

            onSnapshot();
            void refresh();

            return () => {
                active = false;
                unsubscribe();
                unregisterRefresh();
            };
        }, [post.id, post.props?.openclaw_stream?.generation]);

        React.useEffect(() => {
            if (!snapshot) {
                return undefined;
            }
            const delay = Math.max(0, snapshot.expires_at - Date.now()) + 1;
            const timer = window.setTimeout(() => {
                setSnapshot(streamStore.get(post.id));
            }, delay);
            return () => window.clearTimeout(timer);
        }, [post.id, snapshot?.expires_at]);

        const message = window.OpenClawStreamState.messageForPost(post, snapshot, persistedPost);
        const state = props.getState?.();
        const channel = state?.entities?.channels?.channels?.[post.channel_id];
        const team = state?.entities?.teams?.teams?.[channel?.team_id];
        const site = state?.entities?.general?.config?.SiteURL;
        const postUtils = window.PostUtils;
        if (!postUtils?.formatText || !postUtils?.messageHtmlToComponent) {
            return React.createElement('div', null, message);
        }

        const html = postUtils.formatText(message, {
            singleline: false,
            mentionHighlight: true,
            atMentions: true,
            team,
            unsafeLinks: true,
            minimumHashtagLength: 1000000000,
            siteURL: site,
        });
        const rendered = postUtils.messageHtmlToComponent(html, {
            hasPluginTooltips: true,
            latex: false,
            inlinelatex: false,
            postId: post.id,
        });
        const handleInternalLink = (event) => {
            if (event.defaultPrevented || event.button !== 0 ||
                event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
                return;
            }
            const path = event.target.closest?.('a[data-link]')?.getAttribute('data-link');
            const history = window.WebappUtils?.browserHistory;
            if (!path || !history) {
                return;
            }
            event.preventDefault();
            history.push(path);
        };
        return React.createElement('div', {onClick: handleInternalLink}, rendered || React.createElement('p'));
    }

    class Plugin {
        initialize(registry, store) {
            mattermostStore = store;
            registry.registerPostTypeComponent(postType, (props) => window.React.createElement(StreamPost, {
                ...props,
                getState: () => mattermostStore?.getState?.(),
            }));
            registry.registerWebSocketEventHandler(updateEvent, (message) => {
                streamStore.publish(message?.data);
            });
            registry.registerReconnectHandler(() => {
                streamStore.refreshAll();
            });
        }
    }

    window.registerPlugin(pluginID, new Plugin());
}());

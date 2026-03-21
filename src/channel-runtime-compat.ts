type ReplyPrefixOptions = {
  responsePrefix?: string;
  enableSlackInteractiveReplies?: boolean;
  responsePrefixContextProvider: () => unknown;
  onModelSelected: (ctx: unknown) => void;
};

type TypingCallbacks = {
  onReplyStart: () => Promise<void>;
  onIdle?: () => void;
  onCleanup?: () => void;
};

type ChannelRuntimeCompatModule = {
  createReplyPrefixOptions: (params: {
    cfg: Record<string, unknown>;
    agentId: string;
    channel?: string;
    accountId?: string;
  }) => ReplyPrefixOptions;
  createTypingCallbacks: (params: {
    start: () => Promise<void>;
    onStartError: (err: unknown) => void;
  }) => TypingCallbacks;
  logTypingFailure: (params: {
    log: (line: string) => void;
    channel: string;
    target: string;
    error: unknown;
  }) => void;
};

let runtimeModulePromise: Promise<ChannelRuntimeCompatModule> | undefined;

function toCompatModule(candidate: unknown): ChannelRuntimeCompatModule | undefined {
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  if (
    typeof record.createReplyPrefixOptions !== "function" ||
    typeof record.createTypingCallbacks !== "function" ||
    typeof record.logTypingFailure !== "function"
  ) {
    return undefined;
  }

  return {
    createReplyPrefixOptions: record.createReplyPrefixOptions as ChannelRuntimeCompatModule["createReplyPrefixOptions"],
    createTypingCallbacks: record.createTypingCallbacks as ChannelRuntimeCompatModule["createTypingCallbacks"],
    logTypingFailure: record.logTypingFailure as ChannelRuntimeCompatModule["logTypingFailure"],
  };
}

export async function loadChannelRuntimeCompat(): Promise<ChannelRuntimeCompatModule> {
  if (!runtimeModulePromise) {
    runtimeModulePromise = import("openclaw/plugin-sdk/channel-runtime")
      .then((module) => {
        const compat = toCompatModule(module);
        if (!compat) {
          throw new Error("openclaw/plugin-sdk/channel-runtime is missing required exports");
        }
        return compat;
      })
      .catch(async () => {
        const fallback = await import("openclaw/plugin-sdk");
        const compat = toCompatModule(fallback);
        if (!compat) {
          throw new Error("openclaw/plugin-sdk is missing required fallback exports");
        }
        return compat;
      });
  }

  return await runtimeModulePromise;
}

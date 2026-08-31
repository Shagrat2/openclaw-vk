// Типы, которые ядро 8.1 перестало отдавать через публичный plugin-sdk.
// Оба тривиальны, поэтому держим локальные копии вместо импорта из внутренних
// путей ядра — так сборка переживёт очередной пересмотр экспортов.
export type StreamingCompatEntry = {
  streaming?: unknown;
};

export type ChannelProgressDraftMode = "off" | "partial" | "block" | "progress";

"use strict";
(() => {
  // src/runtime/worker.ts
  var scope = self;
  var SYNC_APIS = /* @__PURE__ */ new Set([
    "getSystemInfo",
    "getBackgroundAudioState",
    "setBackgroundAudioState",
    "operateBackgroundAudio",
    "createRequestTask",
    "createUploadTask",
    "createDownloadTask",
    "createSocketTask",
    "operateSocketTask",
    "createAudioInstance"
  ]);
  var send = (message) => scope.postMessage(message);
  var parse = (value) => typeof value === "string" ? JSON.parse(value) : value;
  scope.WeixinWorker = {
    __workerId__: Number(new URLSearchParams(location.search).get("id")),
    postMsgToAppService(message) {
      send({ type: "message", data: parse(message) });
    }
  };
  scope.workerInvokeJsApi = (api, args, callbackId) => {
    if (SYNC_APIS.has(api) || api.endsWith("Sync")) {
      return { errMsg: `${api}:fail wxa-runner \u7684 Worker \u91CC\u4E0D\u652F\u6301\u540C\u6B65\u63A5\u53E3` };
    }
    send({ type: "invoke", api, args: parse(args), callbackId });
    return void 0;
  };
  scope.addEventListener("message", ({ data }) => {
    if (data.type === "message") scope.WeixinWorker.appServiceMsgHandler?.(data.data);
    else scope.WeixinJSBridge.invokeCallbackHandler(data.callbackId, data.result);
  });
  scope.__wxSourceMapRetrace__ = (error) => {
    const err = typeof error?.message === "string" ? error : null;
    send({ type: "error", message: err ? err.message : String(error), stack: typeof err?.stack === "string" ? err.stack : void 0 });
    return error;
  };
})();
//# sourceMappingURL=worker.js.map
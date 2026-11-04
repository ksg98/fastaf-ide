// Presentation fixture only: no backend, PTY, microphone or live config access.
export const isTauri = () => false;
export const owningConnectionFor = () => undefined;
export const buildHttpUrl = (path: string) => path;
export const rpc = async () => undefined;
export const subscribeEvents = async () => () => {};
export const subscribePty = async () => () => {};
export class HttpRpcError extends Error {}
export const useMobileVoice = () => ({available:() => true,armed:() => false,recording:() => false,phase:() => undefined,toggle:async() => {}});
export const OutputView = () => <div>Recorded question presentation; no live terminal</div>;

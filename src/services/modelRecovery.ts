export type RecoveryRequest = { task: string; finish: (retry: boolean) => void };
export const recoveryEvent = 'prism-model-service-unavailable';
export function requestServiceRecovery(task: string): Promise<boolean> {
  return new Promise(resolve => {
    const event = new CustomEvent<RecoveryRequest>(recoveryEvent, { detail: { task, finish: resolve }, cancelable: true });
    window.dispatchEvent(event);
    if (!event.defaultPrevented) resolve(false);
  });
}

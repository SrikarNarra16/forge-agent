/** Auto-scroll only while the user is (nearly) at the bottom; scrolling up to read must never be fought. */
export const STICK_THRESHOLD_PX = 80;

export function shouldStickToBottom(scrollHeight: number, scrollTop: number, clientHeight: number, threshold = STICK_THRESHOLD_PX): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

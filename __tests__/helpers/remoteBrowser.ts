/**
 * check_app_in_browser now picks the caller's own Chrome when none is named and Chrome is installed.
 * These tests exercise the cloud-browser path, so default their calls to browser: 'remote'.
 */
export function forceRemote<T extends (input: any, ...rest: any[]) => any>(handler: T): T {
  return ((input: any, ...rest: any[]) => handler({ browser: 'remote', ...input }, ...rest)) as T;
}

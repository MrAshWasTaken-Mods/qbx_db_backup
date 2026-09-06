declare function GetConvar(name: string, fallback: string): string;
declare function RegisterCommand(
  name: string,
  handler: (source: number, args: string[], raw: string) => void,
  restricted: boolean,
): void;
// biome-ignore lint/suspicious/noExplicitAny: FiveM event payloads are untyped by the runtime.
declare function on(event: string, cb: (...a: any[]) => void): void;
declare function GetCurrentResourceName(): string;
declare function GetResourcePath(resource: string): string;

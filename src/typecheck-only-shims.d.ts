// Development-only type shims for standalone `pi-agent-router` typecheck.

declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }

  interface Process {
    argv: string[];
    env: ProcessEnv;
    execPath: string;
    platform: string;
    exitCode?: number;
    cwd(): string;
    exit(code?: number): never;
  }

  type Timeout = number;
}

declare const process: NodeJS.Process;

declare class Buffer {
  static byteLength(input: string, encoding?: string): number;
  static from(input: string, encoding?: string): Buffer;
  static concat(buffers: readonly Buffer[]): Buffer;
  toString(encoding?: string): string;
  subarray(start?: number, end?: number): Buffer;
  readonly length: number;
}

declare module "node:assert/strict" {
  const assert: any;
  export default assert;
}

declare module "node:child_process" {
  export type ChildProcess = any;
  export function spawn(...args: any[]): ChildProcess;
  export function spawnSync(...args: any[]): any;
}

declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:fs" {
  export function appendFileSync(...args: any[]): void;
  export function copyFileSync(...args: any[]): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(...args: any[]): any;
  export function mkdtempSync(...args: any[]): string;
  export function readFileSync(...args: any[]): string;
  export function readdirSync(...args: any[]): any[];
  export function rmSync(...args: any[]): void;
  export function statSync(...args: any[]): any;
  export function writeFileSync(...args: any[]): void;
}

declare module "node:os" {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...segments: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...segments: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare module "@mariozechner/pi-ai" {
  export type Api = string;
  export type Message = any;
  export type Context = any;
  export type AssistantMessageEventStream = any;
  export type Model<TApi extends Api = Api> = {
    api: TApi;
    provider?: string;
    [key: string]: any;
  };
  export type SimpleStreamOptions = {
    headers?: Record<string, string>;
    temperature?: number;
    [key: string]: any;
  };

  export function getApiProvider(api: Api): {
    streamSimple: (...args: any[]) => AssistantMessageEventStream;
  } | undefined;
}

declare module "@mariozechner/pi-coding-agent" {
  export type AgentToolUpdateCallback<T = any> = (details: T) => void;

  export interface Theme {
    [key: string]: any;
  }

  export interface ExtensionContext {
    [key: string]: any;
    hasUI?: boolean;
    cwd?: string;
    ui: {
      [key: string]: any;
      theme?: Theme;
      custom?<T>(...args: any[]): Promise<T>;
    };
    model?: any;
    modelRegistry: any;
  }

  export interface ExtensionAPI {
    [key: string]: any;
    appendEntry?<T>(...args: any[]): any;
    on?(...args: any[]): any;
    registerCommand?(...args: any[]): any;
    registerProvider?(...args: any[]): any;
  }

  export function getMarkdownTheme(): any;
  export function getSettingsListTheme(theme?: Theme): any;
}

declare module "@mariozechner/pi-tui" {
  export type SettingItem = any;

  export class Box {
    [key: string]: any;
    constructor(...args: any[]);
  }

  export class Container {
    [key: string]: any;
    constructor(...args: any[]);
  }

  export class Markdown {
    [key: string]: any;
    constructor(...args: any[]);
    render(width: number): string[];
  }

  export class SettingsList {
    [key: string]: any;
    constructor(...args: any[]);
  }

  export class Spacer {
    [key: string]: any;
    constructor(...args: any[]);
  }

  export class Text {
    [key: string]: any;
    constructor(...args: any[]);
  }

  export function matchesKey(...args: any[]): boolean;
  export function truncateToWidth(...args: any[]): string;
  export function visibleWidth(...args: any[]): number;
  export function wrapTextWithAnsi(...args: any[]): any;
}

declare module "@sinclair/typebox" {
  export const Type: any;
}

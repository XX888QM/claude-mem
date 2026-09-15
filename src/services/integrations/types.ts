
export type CursorInstallTarget = 'project' | 'user' | 'enterprise';

export interface CursorHooksJson {
  version: number;
  hooks: {
    sessionStart?: Array<{ command: string }>;
    beforeSubmitPrompt?: Array<{ command: string }>;
    afterMCPExecution?: Array<{ command: string }>;
    afterShellExecution?: Array<{ command: string }>;
    afterFileEdit?: Array<{ command: string }>;
    stop?: Array<{ command: string }>;
  };
}

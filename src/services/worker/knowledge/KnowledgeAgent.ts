
import { CorpusStore } from './CorpusStore.js';
import { CorpusRenderer } from './CorpusRenderer.js';
import type { CorpusFile, QueryResult } from './types.js';
import { logger } from '../../../utils/logger.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, OBSERVER_SESSIONS_DIR, ensureDir } from '../../../shared/paths.js';
import { buildIsolatedEnvWithFreshOAuth } from '../../../shared/EnvManager.js';
import { findClaudeExecutable } from '../../../shared/find-claude-executable.js';
import { sanitizeEnv } from '../../../supervisor/env-sanitizer.js';
import { resolveTierAlias } from '../model-aliases.js';

// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildHardenedSdkOptions } from '../../../sdk/hardened-options.js';
import { CLAUDE_QUOTA_DISABLED_MESSAGE, isClaudeSubscriptionDisallowed } from '../claude-quota-policy.js';

export class KnowledgeAgent {
  private renderer: CorpusRenderer;

  constructor(
    private corpusStore: CorpusStore
  ) {
    this.renderer = new CorpusRenderer();
  }

  async prime(corpus: CorpusFile): Promise<string> {
    if (isClaudeSubscriptionDisallowed()) {
      throw new Error(CLAUDE_QUOTA_DISABLED_MESSAGE);
    }
    const renderedCorpus = this.renderer.renderCorpus(corpus);

    const primePrompt = [
      corpus.system_prompt,
      '',
      'Here is your complete knowledge base:',
      '',
      renderedCorpus,
      '',
      'Acknowledge what you\'ve received. Summarize the key themes and topics you can answer questions about.'
    ].join('\n');

    ensureDir(OBSERVER_SESSIONS_DIR);
    const claudePath = findClaudeExecutable('WORKER');
    const isolatedEnv = sanitizeEnv(await buildIsolatedEnvWithFreshOAuth());

    const queryResult = query({
      prompt: primePrompt,
      options: buildHardenedSdkOptions({
        source: 'KnowledgeAgent',
        project: corpus.name,
        model: this.getModelId(),
        env: isolatedEnv,
        pathToClaudeCodeExecutable: claudePath,
      }),
    });

    let sessionId: string | undefined;
    let succeeded = false;
    try {
      for await (const msg of queryResult) {
        if (msg.session_id) sessionId = msg.session_id;
        if (msg.type === 'result') {
          succeeded = msg.subtype === 'success' && !msg.is_error;
        }
      }
    } catch (error) {
      if (sessionId) {
        if (error instanceof Error) {
          logger.debug('WORKER', `SDK process exited after priming corpus "${corpus.name}" — session captured, continuing`, {}, error);
        } else {
          logger.debug('WORKER', `SDK process exited after priming corpus "${corpus.name}" — session captured, continuing (non-Error thrown)`, { thrownValue: String(error) });
        }
      } else {
        throw error;
      }
    }

    if (!sessionId || !succeeded) {
      throw new Error('Knowledge priming failed. Check Claude login and worker logs, or use get_corpus without a separate model session.');
    }

    corpus.session_id = sessionId;
    this.corpusStore.write(corpus);

    return sessionId;
  }

  async query(corpus: CorpusFile, question: string): Promise<QueryResult> {
    if (!corpus.session_id) {
      throw new Error(`Corpus "${corpus.name}" has no session — call prime first`);
    }

    try {
      const result = await this.executeQuery(corpus, question);
      if (result.session_id !== corpus.session_id) {
        corpus.session_id = result.session_id;
        this.corpusStore.write(corpus);
      }
      return result;
    } catch (error) {
      if (!this.isSessionResumeError(error)) {
        if (error instanceof Error) {
          logger.error('WORKER', `Query failed for corpus "${corpus.name}"`, {}, error);
        } else {
          logger.error('WORKER', `Query failed for corpus "${corpus.name}" (non-Error thrown)`, { thrownValue: String(error) });
        }
        throw error;
      }
      logger.info('WORKER', `Session expired for corpus "${corpus.name}", auto-repriming...`);
      await this.prime(corpus);
      const refreshedCorpus = this.corpusStore.read(corpus.name);
      if (!refreshedCorpus || !refreshedCorpus.session_id) {
        throw new Error(`Auto-reprime failed for corpus "${corpus.name}"`);
      }
      const result = await this.executeQuery(refreshedCorpus, question);
      if (result.session_id !== refreshedCorpus.session_id) {
        refreshedCorpus.session_id = result.session_id;
        this.corpusStore.write(refreshedCorpus);
      }
      return result;
    }
  }

  async reprime(corpus: CorpusFile): Promise<string> {
    corpus.session_id = null;  
    return this.prime(corpus);
  }

  private isSessionResumeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /session|resume|expired|invalid.*session|not found/i.test(message);
  }

  private async executeQuery(corpus: CorpusFile, question: string): Promise<QueryResult> {
    if (isClaudeSubscriptionDisallowed()) {
      throw new Error(CLAUDE_QUOTA_DISABLED_MESSAGE);
    }
    ensureDir(OBSERVER_SESSIONS_DIR);
    const claudePath = findClaudeExecutable('WORKER');
    const isolatedEnv = sanitizeEnv(await buildIsolatedEnvWithFreshOAuth());

    const queryResult = query({
      prompt: question,
      options: buildHardenedSdkOptions({
        source: 'KnowledgeAgent',
        project: corpus.name,
        model: this.getModelId(),
        env: isolatedEnv,
        pathToClaudeCodeExecutable: claudePath,
        resume: corpus.session_id!,
      }),
    });

    let answer = '';
    let succeeded = false;
    let newSessionId = corpus.session_id!;
    try {
      for await (const msg of queryResult) {
        if (msg.session_id) newSessionId = msg.session_id;
        if (msg.type === 'result') succeeded = msg.subtype === 'success' && !msg.is_error;
        if (msg.type === 'assistant') {
          const text = msg.message.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('');
          answer = text;
        }
      }
    } catch (error) {
      if (answer) {
        if (error instanceof Error) {
          logger.debug('WORKER', `SDK process exited after query — answer captured, continuing`, {}, error);
        } else {
          logger.debug('WORKER', `SDK process exited after query — answer captured, continuing (non-Error thrown)`, { thrownValue: String(error) });
        }
      } else {
        throw error;
      }
    }

    if (!succeeded || !answer.trim()) {
      throw new Error('Knowledge query failed. Check Claude login and worker logs, or use get_corpus to read saved records directly.');
    }
    return { answer, session_id: newSessionId };
  }

  private getModelId(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    // Resolve $TIER:<fast|smart|simple|summary> aliases at request time (#2289).
    return resolveTierAlias(settings.CLAUDE_MEM_MODEL, settings);
  }

}

import type { AgentProviderId, AgentProviderMeta } from '../../../shared/types';
import type { IAgentProvider } from './agent-types';
import { toAgentProviderMeta } from './agent-types';

class AgentRegistry {
  private providers = new Map<AgentProviderId, IAgentProvider>();

  register(provider: IAgentProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: AgentProviderId): IAgentProvider | undefined {
    return this.providers.get(id);
  }

  getAll(): IAgentProvider[] {
    return Array.from(this.providers.values());
  }

  getAllMeta(): AgentProviderMeta[] {
    return this.getAll().map(toAgentProviderMeta);
  }

  /** Like getAllMeta(), but lets providers replace their static model list
   *  with a live-fetched catalog (e.g. the Anthropic Models API). Falls back
   *  to the static list per provider on any failure. */
  async getAllMetaLive(): Promise<AgentProviderMeta[]> {
    return Promise.all(
      this.getAll().map(async (p) => {
        const meta = toAgentProviderMeta(p);
        if (p.fetchModels) {
          try {
            const live = await p.fetchModels();
            if (live && live.length > 0) meta.models = live;
          } catch {
            // keep static models
          }
        }
        return meta;
      })
    );
  }
}

/** Singleton agent registry — populated at startup via registerAllAgents() */
export const agentRegistry = new AgentRegistry();

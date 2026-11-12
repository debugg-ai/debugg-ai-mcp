import type { Brain, BrainDecision } from '../../services/localExecutor/runner.js';
import type { StepResult } from '../../services/localExecutor/types.js';

/** Test brain: decides each step with a function of the previous result. */
export class ScriptedBrain implements Brain {
  cancelled: string[] = [];
  seen: StepResult[] = [];
  constructor(private readonly decide: (prev: StepResult, seq: number) => BrainDecision) {}
  async open() { return { sessionId: 'stub' }; }
  async step(_id: string, seq: number, prev: StepResult | null): Promise<BrainDecision> {
    this.seen.push(prev!);
    return this.decide(prev!, seq);
  }
  async cancel(_id: string, reason: string) { this.cancelled.push(reason); }
}

import { answerDraft } from '../generation/pipeline.js';
import { verifyDraft, type VerificationPolicy } from './verify.js';
import type { EntailmentVerifier } from './nli.js';

export async function answerVerified(
  request: Parameters<typeof answerDraft>[0],
  dependencies: Parameters<typeof answerDraft>[1] & {
    verifier: EntailmentVerifier;
  },
  policy: VerificationPolicy = {},
  signal?: AbortSignal,
) {
  const draft = await answerDraft(request, dependencies, signal);
  return verifyDraft(draft, dependencies.verifier, policy, signal);
}

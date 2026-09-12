import { CLAUDE_OPUS_4_6_CONFIG } from '../model/configs.js'

// @[MODEL LAUNCH]: Update the fallback model below.
// When the user has never set teammateDefaultModel in /config, new teammates
// use Opus 4.6. Must be provider-aware so Bedrock/Vertex/Foundry customers get
// the correct model ID.
export function getHardcodedTeammateModelFallback(): string {
<<<<<<< Updated upstream
<<<<<<< Updated upstream
  const config = CLAUDE_OPUS_4_6_CONFIG
  const provider = getAPIProvider()
  return (
    (config as Record<string, string | undefined>)[provider] ??
    config.firstParty ??
    config.openai
  )
=======
=======
>>>>>>> Stashed changes
  // Opus 4.6 does not have per-provider model IDs for the default
  // opencode-free provider, so we always return the canonical first-party
  // string for consistency across providers.
  return CLAUDE_OPUS_4_6_CONFIG.firstParty
<<<<<<< Updated upstream
>>>>>>> Stashed changes
=======
>>>>>>> Stashed changes
}

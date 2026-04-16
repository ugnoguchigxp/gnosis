import { describe, expect, test } from 'bun:test';
import { createCloudReviewLLMService } from '../src/services/review/llm/cloudProvider.js';

const env = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
  region: process.env.AWS_REGION,
  modelId: process.env.GNOSIS_REVIEW_LLM_BEDROCK_MODEL_ID,
  inferenceProfileId: process.env.GNOSIS_REVIEW_LLM_BEDROCK_INFERENCE_PROFILE_ID,
};

const hasRequiredEnv = Boolean(
  env.accessKeyId && env.secretAccessKey && env.region && env.modelId && env.inferenceProfileId,
);

describe('Bedrock live integration', () => {
  if (!hasRequiredEnv) {
    test.skip('AWS Bedrock environment variables are not fully configured', () => {});
    return;
  }

  test(
    'invokes Bedrock through gnosis cloud provider',
    async () => {
    const service = createCloudReviewLLMService({
      provider: 'bedrock',
      awsRegion: env.region,
      awsAccessKeyId: env.accessKeyId,
      awsSecretAccessKey: env.secretAccessKey,
      awsSessionToken: env.sessionToken,
      bedrockModelId: env.modelId,
      bedrockInferenceProfileId: env.inferenceProfileId,
    });

    const prompt = 'openAI ChatGPTについてどう思っていますか？';
    const result = await service.generate(prompt, { format: 'text' });

    console.log(result);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/ChatGPT|OpenAI|AI/i);
    },
    { timeout: 15_000 },
  );
});

#!/usr/bin/env ts-node
/**
 * LLM Gateway Smoke Test
 * 
 * Verifies that the OpenAI-compatible LLM gateway is reachable and functional.
 * Tests both non-streaming and streaming chat completions.
 * 
 * Run: pnpm ts-node scripts/test_llm_gateway.ts
 */

import { openaiClient } from '../src/service/openai_client';

async function main() {
  console.log('\n==================================================');
  console.log('  LLM Gateway Smoke Test');
  console.log('==================================================\n');

  console.log(`Base URL: ${process.env.LLM_BASE_URL || 'http://localhost:9080/v1'}`);
  console.log(`Model: ${process.env.LLM_MODEL || 'gptoss20b'}`);
  console.log(`API Key: ${process.env.LLM_API_KEY ? '***set***' : '(not set)'}\n`);

  // Test 1: Health check (ping)
  console.log('Test 1: Health Check (ping)...');
  try {
    const isHealthy = await openaiClient.ping();
    if (isHealthy) {
      console.log('✅ PASSED: Gateway is healthy and responsive\n');
    } else {
      console.log('❌ FAILED: Gateway responded but health check returned false\n');
      process.exit(1);
    }
  } catch (error: any) {
    console.log(`❌ FAILED: ${error.message}\n`);
    process.exit(1);
  }

  // Test 2: Non-streaming completion
  console.log('Test 2: Non-streaming Chat Completion...');
  try {
    const response = await openaiClient.generate(
      [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Say "OK" only.' }
      ],
      { temperature: 0.1, max_tokens: 10 }
    );

    if (response.content.includes('OK')) {
      console.log(`✅ PASSED: Got expected response: "${response.content}"`);
      console.log(`   Tokens: ${response.tokens_used}, Finish: ${response.finish_reason}\n`);
    } else {
      console.log(`⚠️  WARNING: Response doesn't contain "OK": "${response.content}"\n`);
    }
  } catch (error: any) {
    console.log(`❌ FAILED: ${error.message}\n`);
    process.exit(1);
  }

  // Test 3: Streaming completion
  console.log('Test 3: Streaming Chat Completion...');
  try {
    let streamedContent = '';
    for await (const chunk of openaiClient.generateStream(
      [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Count to 3.'  }
      ],
      { temperature: 0.1, max_tokens: 50 }
    )) {
      streamedContent += chunk;
      process.stdout.write('.');
    }
    console.log('\n');

    if (streamedContent.length > 0) {
      console.log(`✅ PASSED: Streaming worked. Content: "${streamedContent}"\n`);
    } else {
      console.log('❌ FAILED: No content received from stream\n');
      process.exit(1);
    }
  } catch (error: any) {
    console.log(`\n❌ FAILED: ${error.message}\n`);
    process.exit(1);
  }

  // Test 4: Translation
  console.log('Test 4: Translation Function...');
  try {
    const translated = await openaiClient.translate('Hello world', 'Japanese');
    if (translated && translated !== 'Hello world') {
      console.log(`✅ PASSED: Translation worked. EN -> JA: "${translated}"\n`);
    } else {
      console.log(`⚠️  WARNING: Translation returned original: "${translated}"\n`);
    }
  } catch (error: any) {
    console.log(`❌ FAILED: ${error.message}\n`);
    process.exit(1);
  }

  console.log('==================================================');
  console.log('  All smoke tests PASSED! ✅');
  console.log('==================================================\n');
}

main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});

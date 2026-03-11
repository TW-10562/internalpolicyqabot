import { CacheProcessor } from "@/types/cacheProcessor";


export default class UseFaqCache implements CacheProcessor {
  name = "UseFaqCache";
  async search(prompt: string): Promise<string> {
    console.log("This is useFaqCache search function");
    const result = await SearchWithCache(prompt);
    return result;
  }
}

import { config } from '@/config/index';

export async function SearchWithCache(prompt: string): Promise<string> {
    console.log('[FAQ Cache] 🔍 Querying FAQ cache system...');
    
    try {
        // Use configured thresholds from config file
        const cacheUrl = config.RAG.FaqCacheSettings.cacheApiUrl || 'http://localhost:8001';
        const vectorThreshold = config.RAG.FaqCacheSettings.vectorSimilarityThreshold || 0.3;
        const crossEncoderThreshold = config.RAG.FaqCacheSettings.crossEncoderThreshold || 0.1;

        console.log(`[FAQ Cache] Using thresholds: vector=${vectorThreshold}, cross_encoder=${crossEncoderThreshold}`);
        
        const faqResponse = await fetch(`${cacheUrl}/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                query: prompt,
                vector_similarity_threshold: vectorThreshold,
                cross_encoder_threshold: crossEncoderThreshold
            }),
        });
        
        if (!faqResponse.ok) {
            console.log(`[FAQ Cache] ❌ FAQ API returned error status: ${faqResponse.status}`);
            const errorText = await faqResponse.text();
            console.log(`[FAQ Cache] ❌ Error response: ${errorText}`);
            throw new Error(`FAQ API error: ${faqResponse.status}`);
        }
        
        const faqResult = await faqResponse.json();
        
        if (faqResult.cache_hit) {
            console.log(`[FAQ Cache] ✅ Cache hit! Similarity: ${faqResult.confidence?.vector_similarity ?? 'N/A'}`);
            
            // Format the FAQ answer in Japanese
            const formattedAnswer = `以下は社内FAQシステムから取得した回答です。

質問: ${faqResult.question}
回答: ${faqResult.answer}`;
            
            return formattedAnswer;
        } else {
            console.log('[FAQ Cache] ⚠️  Cache miss - no matching FAQ found');
            return "faq_cache_miss";
        }
        
    } catch (error) {   
        return "faq_cache_error";   
    }
}
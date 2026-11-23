import OpenAI from 'openai';
import type {
  Confidence,
  ConversationOrderSignal,
  ConversationSalesSignal,
  InsightEvidence,
  InsightExplicitness,
  ManualTranscriptCoachingSignal,
  RecordingConversationAnalysis,
  RecordingTranscriptTurn,
  SentimentCue,
  VisitOutcome
} from '@itc/domain';

export const OPENAI_CONVERSATION_ANALYSIS_MODEL = 'gpt-4o-mini';
export const CONVERSATION_ANALYSIS_PROMPT_VERSION = 'field-sales-evidence-v1';
export const CONVERSATION_ANALYSIS_VERSION = `sales-signals-v1/${CONVERSATION_ANALYSIS_PROMPT_VERSION}`;

export type ConversationAnalysisContent = Pick<RecordingConversationAnalysis,
  'outcome' | 'outcomeConfidence' | 'outcomeExplicitness' | 'outcomeEvidence' | 'summary'
  | 'confirmedOrders' | 'salesSignals' | 'sentimentCue' | 'sentimentConfidence'
  | 'nextAction' | 'nextActionDue' | 'nextActionEvidence' | 'coachingSignals'>;

/** Fixed aggregation keys keep the manager's recurring field signals comparable across transcripts. */
export const TAXONOMY_KEYS = [
  'shopper_requests', 'product_preference', 'pack_size_preference', 'price_point_demand', 'occasion_demand', 'sales_velocity',
  'margin', 'credit_terms', 'price', 'shelf_space', 'assortment_fit', 'competitor_offer',
  'stock_out', 'low_stock', 'replenishment_timing', 'delivery_reliability', 'assortment_gap',
  'competitor_price', 'competitor_product', 'competitor_pack', 'competitive_substitution',
  'positive_feedback', 'hesitation', 'dissatisfaction', 'risk_concern',
  'callback', 'delivery_confirmation', 'sample_follow_up', 'price_list_follow_up', 'manager_escalation', 'order_follow_up',
  'discovery', 'benefit_explanation', 'objection_response', 'close_or_next_step', 'other'
] as const;
type TaxonomyKey = typeof TAXONOMY_KEYS[number];
const TAXONOMY_KEYS_BY_CATEGORY: Record<ConversationSalesSignal['category'], readonly TaxonomyKey[]> = {
  demand: ['shopper_requests', 'product_preference', 'pack_size_preference', 'price_point_demand', 'occasion_demand', 'sales_velocity', 'other'],
  objection: ['margin', 'credit_terms', 'price', 'shelf_space', 'assortment_fit', 'competitor_offer', 'other'],
  availability: ['stock_out', 'low_stock', 'replenishment_timing', 'delivery_reliability', 'assortment_gap', 'other'],
  competitor: ['competitor_price', 'competitor_product', 'competitor_pack', 'competitive_substitution', 'other'],
  sentiment: ['positive_feedback', 'hesitation', 'dissatisfaction', 'risk_concern', 'other'],
  commitment: ['callback', 'delivery_confirmation', 'sample_follow_up', 'price_list_follow_up', 'manager_escalation', 'order_follow_up', 'other'],
  conversation_quality: ['discovery', 'benefit_explanation', 'objection_response', 'close_or_next_step', 'other']
};

export class ConversationAnalysisError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ConversationAnalysisError';
  }
}

type SpeakerRole = { speaker: string; role: 'representative' | 'shopkeeper' | 'unknown' };
type ModelEvidence = { segmentIds: string[]; quote: string; startMs: number | null; endMs: number | null };
type ModelOrder = {
  id: string; intent: ConversationOrderSignal['intent']; productName: string | null; brand: string | null;
  packDescription: string | null; quantity: number | null; quantityUnit: string | null;
  unitPriceInr: number | null; totalValueInr: number | null; confidence: Confidence; evidence: ModelEvidence[];
  retailerAssentSpeaker: string | null;
};
type ModelSignal = {
  id: string; category: ConversationSalesSignal['category']; taxonomyKey: string; title: string; summary: string;
  confidence: Confidence; evidence: ModelEvidence[]; suggestedAction: string | null;
  explicitness: InsightExplicitness; mentionCount: number; productName: string | null; brand: string | null;
  packDescription: string | null; explicitCount: number | null; countUnit: string | null;
  status: NonNullable<ConversationSalesSignal['status']>;
};
type ModelCoaching = {
  rubricKey: ManualTranscriptCoachingSignal['rubricKey']; label: string; confidence: Confidence;
  evidenceSegmentIds: string[]; note: string;
};
type ModelOutput = {
  speakerRoles: SpeakerRole[];
  outcome: VisitOutcome; outcomeConfidence: Confidence; outcomeExplicitness: InsightExplicitness;
  outcomeEvidence: ModelEvidence[]; summary: string | null; confirmedOrders: ModelOrder[];
  salesSignals: ModelSignal[]; sentimentCue: SentimentCue; sentimentConfidence: Confidence;
  nextAction: string | null; nextActionDue: string | null; nextActionEvidence: ModelEvidence[];
  coachingSignals: ModelCoaching[];
};

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableNumber = { anyOf: [{ type: 'number' }, { type: 'null' }] };
const confidence = { type: 'string', enum: ['high', 'medium', 'low'] };
const explicitness = { type: 'string', enum: ['explicit', 'inferred', 'uncertain'] };
const evidenceSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    segmentIds: { type: 'array', items: { type: 'string' } }, quote: { type: 'string' },
    startMs: nullableNumber, endMs: nullableNumber
  }, required: ['segmentIds', 'quote', 'startMs', 'endMs']
};
const outputSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    speakerRoles: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { speaker: { type: 'string' }, role: { type: 'string', enum: ['representative', 'shopkeeper', 'unknown'] } },
      required: ['speaker', 'role']
    } },
    outcome: { type: 'string', enum: ['order_placed', 'follow_up', 'no_order', 'new_outlet', 'not_stated'] },
    outcomeConfidence: confidence, outcomeExplicitness: explicitness,
    outcomeEvidence: { type: 'array', items: evidenceSchema }, summary: nullableString,
    confirmedOrders: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string' }, intent: { type: 'string', enum: ['confirmed', 'conditional', 'considering', 'declined', 'unknown'] },
        productName: nullableString, brand: nullableString, packDescription: nullableString,
        quantity: nullableNumber, quantityUnit: nullableString, unitPriceInr: nullableNumber,
        totalValueInr: nullableNumber, confidence, evidence: { type: 'array', items: evidenceSchema },
        retailerAssentSpeaker: nullableString
      },
      required: ['id', 'intent', 'productName', 'brand', 'packDescription', 'quantity', 'quantityUnit', 'unitPriceInr', 'totalValueInr', 'confidence', 'evidence', 'retailerAssentSpeaker']
    } },
    salesSignals: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string' }, category: { type: 'string', enum: ['demand', 'objection', 'availability', 'competitor', 'sentiment', 'commitment', 'conversation_quality'] },
        taxonomyKey: { type: 'string', enum: TAXONOMY_KEYS }, title: { type: 'string' }, summary: { type: 'string' }, confidence,
        evidence: { type: 'array', items: evidenceSchema }, suggestedAction: nullableString, explicitness,
        mentionCount: { type: 'integer', minimum: 1 }, productName: nullableString, brand: nullableString,
        packDescription: nullableString, explicitCount: nullableNumber, countUnit: nullableString,
        status: { type: 'string', enum: ['reported', 'conditional', 'unverified', 'resolved', 'unknown'] }
      },
      required: ['id', 'category', 'taxonomyKey', 'title', 'summary', 'confidence', 'evidence', 'suggestedAction', 'explicitness', 'mentionCount', 'productName', 'brand', 'packDescription', 'explicitCount', 'countUnit', 'status']
    } },
    sentimentCue: { type: 'string', enum: ['positive', 'neutral', 'hesitant', 'at_risk', 'unknown'] },
    sentimentConfidence: confidence, nextAction: nullableString, nextActionDue: nullableString,
    nextActionEvidence: { type: 'array', items: evidenceSchema },
    coachingSignals: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        rubricKey: { type: 'string', enum: ['discovery', 'benefit_explanation', 'objection_response', 'close_or_next_step'] },
        label: { type: 'string' }, confidence, evidenceSegmentIds: { type: 'array', items: { type: 'string' } }, note: { type: 'string' }
      },
      required: ['rubricKey', 'label', 'confidence', 'evidenceSegmentIds', 'note']
    } }
  },
  required: ['speakerRoles', 'outcome', 'outcomeConfidence', 'outcomeExplicitness', 'outcomeEvidence', 'summary', 'confirmedOrders', 'salesSignals', 'sentimentCue', 'sentimentConfidence', 'nextAction', 'nextActionDue', 'nextActionEvidence', 'coachingSignals']
};

const SYSTEM_PROMPT = `You analyze consented in-person field sales conversations between a sales representative and an Indian shopkeeper. Return only structured facts supported by the diarized transcript. Preserve English, Hindi, and Bengali wording as written; do not translate product names or code-switched quotes. Distinguish retailer-reported shopper demand from the retailer's own purchase intent. A confirmed order requires explicit retailer assent or an explicit order instruction. A representative proposal alone, an unknown speaker, a conditional trial, or a future decision is not a confirmed order. A total order value may be returned only when the retailer explicitly states the total with a currency cue; never calculate it from quantity and unit price. Do not infer quantity, price, pack size, stock-out duration, competitor identity, sentiment, or follow-up due date. Return nextActionDue only when an ISO date/time is explicitly present in the cited quote; otherwise return null. Use null, unknown, not_stated, low confidence, or an empty evidence list when the transcript does not establish a fact. Every outcome, order, signal, coaching note, and follow-up must cite exact segment IDs and an exact quote. Coaching is evidence for discussion, never an employee score. Include only useful sales signals for demand, objection, availability, competitor, sentiment, commitment, or conversation quality. Select taxonomyKey only from the fixed category-specific key allowlist in the schema; use other when no key fits. Mention counts should count separately supported mentions in this visit, not visits.`;

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function explicitlyStatedRetailerTotal(value: number, evidence: InsightEvidence[], turns: RecordingTranscriptTurn[], speakerRoles: Map<string, SpeakerRole['role']>): boolean {
  const totalCue = /\b(?:total|grand total|altogether|all together|overall)\b|कुल|टोटल|মোট|সর্বমোট/i;
  const currencyAmount = /(?:₹|\b(?:rs\.?|inr)\s*)([0-9][0-9,]*(?:\.\d+)?)|([0-9][0-9,]*(?:\.\d+)?)\s*(?:\b(?:rupees?|rs\.?|inr)\b|रुपये|रुपए|रुपया|টাকা)/gi;
  return evidence.some((item) => {
    if (!totalCue.test(item.quote)) return false;
    const containsRetailer = item.segmentIds.some((id) => {
      const turn = turns.find((candidate) => candidate.id === id);
      return Boolean(turn && speakerRoles.get(turn.speaker) === 'shopkeeper');
    });
    if (!containsRetailer) return false;
    const statedValues = [...item.quote.matchAll(currencyAmount)]
      .map((match) => Number((match[1] ?? match[2])?.replaceAll(',', '')))
      .filter(Number.isFinite);
    return statedValues.some((stated) => stated === value);
  });
}

function explicitlyEvidencedDate(value: string, evidence: InsightEvidence[]): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?)?)?$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  if (hourText !== undefined && (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText ?? 0) > 59)) return false;
  return evidence.some((item) => normalizeText(item.quote).includes(`${yearText}-${monthText}-${dayText}`));
}

function verifyEvidence(values: ModelEvidence[], turns: RecordingTranscriptTurn[]): InsightEvidence[] {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  return values.flatMap((value) => {
    if (!value || !Array.isArray(value.segmentIds) || !value.segmentIds.length || typeof value.quote !== 'string' || !value.quote.trim()) return [];
    const segments = value.segmentIds.map((id) => byId.get(id));
    if (segments.some((segment) => !segment)) return [];
    const source = normalizeText(segments.map((segment) => segment!.text).join(' '));
    if (!source.includes(normalizeText(value.quote))) return [];
    const earliest = Math.min(...segments.map((segment) => segment!.startMs));
    const latest = Math.max(...segments.map((segment) => segment!.endMs));
    const startMs = Number.isInteger(value.startMs) && value.startMs! >= earliest && value.startMs! < latest ? value.startMs! : undefined;
    const endMs = Number.isInteger(value.endMs) && value.endMs! > (startMs ?? earliest) && value.endMs! <= latest ? value.endMs! : undefined;
    return [{ segmentIds: [...new Set(value.segmentIds)], quote: value.quote, ...(startMs === undefined ? {} : { startMs }), ...(endMs === undefined ? {} : { endMs }) }];
  });
}

export function validateStructuredConversationAnalysis(value: unknown, turns: RecordingTranscriptTurn[]): ConversationAnalysisContent {
  if (!value || typeof value !== 'object') throw new ConversationAnalysisError('analysis_invalid_output', 'Structured analysis returned invalid data.', true);
  const output = value as ModelOutput;
  const validTurnIds = new Set(turns.map((turn) => turn.id));
  const speakers = new Set(turns.map((turn) => turn.speaker));
  const assignments = new Map<string, Set<SpeakerRole['role']>>();
  for (const item of output.speakerRoles) {
    if (!speakers.has(item.speaker)) continue;
    const roles = assignments.get(item.speaker) ?? new Set<SpeakerRole['role']>();
    roles.add(item.role);
    assignments.set(item.speaker, roles);
  }
  const speakerRoles = new Map<string, SpeakerRole['role']>([...speakers].map((speaker) => {
    const roles = assignments.get(speaker);
    return [speaker, roles?.size === 1 ? [...roles][0]! : 'unknown'];
  }));
  const roleCounts = [...speakerRoles.values()].reduce((counts, role) => {
    counts[role] += 1;
    return counts;
  }, { representative: 0, shopkeeper: 0, unknown: 0 });
  // A confirmed order depends on distinguishing the salesperson's proposal
  // from the retailer's assent. Ambiguous role assignments cannot establish it.
  if (roleCounts.representative !== 1 || roleCounts.shopkeeper !== 1) {
    for (const speaker of speakers) speakerRoles.set(speaker, 'unknown');
  }
  const validOutcomeEvidence = verifyEvidence(output.outcomeEvidence, turns);
  const outcome = validOutcomeEvidence.length ? output.outcome : 'not_stated';
  const orders: ConversationOrderSignal[] = output.confirmedOrders.flatMap((item) => {
    const evidence = verifyEvidence(item.evidence, turns);
    if (!evidence.length) return [];
    let intent = item.intent;
    if (intent === 'confirmed') {
      const citedRetailerAssent = evidence.some((entry) => entry.segmentIds.some((id) => {
        const turn = turns.find((candidate) => candidate.id === id);
        return Boolean(turn && turn.speaker === item.retailerAssentSpeaker && speakerRoles.get(turn.speaker) === 'shopkeeper');
      }));
      if (!citedRetailerAssent) intent = 'unknown';
    }
    const nonnegative = (n: number | null) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
    const proposedTotal = nonnegative(item.totalValueInr);
    const totalValueInr = proposedTotal !== undefined
      && explicitlyStatedRetailerTotal(proposedTotal, evidence, turns, speakerRoles) ? proposedTotal : undefined;
    return [{
      id: item.id, intent, ...(item.productName ? { productName: item.productName } : {}),
      ...(item.brand ? { brand: item.brand } : {}), ...(item.packDescription ? { packDescription: item.packDescription } : {}),
      ...(nonnegative(item.quantity) === undefined ? {} : { quantity: nonnegative(item.quantity) }),
      ...(item.quantityUnit ? { quantityUnit: item.quantityUnit } : {}),
      ...(nonnegative(item.unitPriceInr) === undefined ? {} : { unitPriceInr: nonnegative(item.unitPriceInr) }),
      ...(totalValueInr === undefined ? {} : { totalValueInr }),
      confidence: item.confidence, evidence
    }];
  });
  const nextActionEvidence = verifyEvidence(output.nextActionEvidence, turns);
  const outcomeIsSupported = validOutcomeEvidence.length > 0
    && (output.outcome !== 'order_placed' || orders.some((order) => order.intent === 'confirmed'))
    && (output.outcome !== 'follow_up' || Boolean(output.nextAction && nextActionEvidence.length));
  const validatedOutcome = outcomeIsSupported ? output.outcome : 'not_stated';
  const signals: ConversationSalesSignal[] = output.salesSignals.flatMap((item) => {
    const evidence = verifyEvidence(item.evidence, turns);
    if (!evidence.length) return [];
    const taxonomyKey = TAXONOMY_KEYS_BY_CATEGORY[item.category].includes(item.taxonomyKey as TaxonomyKey)
      ? item.taxonomyKey
      : 'other';
    const mentionCount = Math.max(1, Math.min(item.mentionCount, evidence.length));
    const numberOrUndefined = (n: number | null) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
    return [{
      id: item.id, category: item.category, taxonomyKey,
      title: item.title, summary: item.summary, confidence: item.confidence, evidence,
      ...(item.suggestedAction ? { suggestedAction: item.suggestedAction } : {}),
      explicitness: item.explicitness, mentionCount,
      ...(item.productName ? { productName: item.productName } : {}), ...(item.brand ? { brand: item.brand } : {}),
      ...(item.packDescription ? { packDescription: item.packDescription } : {}),
      ...(numberOrUndefined(item.explicitCount) === undefined ? {} : { explicitCount: numberOrUndefined(item.explicitCount) }),
      ...(item.countUnit ? { countUnit: item.countUnit } : {}), status: item.status
    }];
  });
  const coachingSignals: ManualTranscriptCoachingSignal[] = output.coachingSignals.flatMap((item) => {
    const evidenceSegmentIds = [...new Set(item.evidenceSegmentIds.filter((id) => validTurnIds.has(id)))];
    return evidenceSegmentIds.length ? [{ ...item, evidenceSegmentIds }] : [];
  });
  const sentiment = output.sentimentCue === 'positive' || output.sentimentCue === 'neutral'
    || output.sentimentCue === 'hesitant' || output.sentimentCue === 'at_risk' ? output.sentimentCue : 'unknown';
  return {
    outcome: validatedOutcome,
    outcomeConfidence: outcomeIsSupported ? output.outcomeConfidence : 'low',
    outcomeExplicitness: outcomeIsSupported ? output.outcomeExplicitness : 'uncertain',
    outcomeEvidence: outcomeIsSupported ? validOutcomeEvidence : [],
    ...(output.summary?.trim() ? { summary: output.summary.trim() } : {}),
    confirmedOrders: orders,
    salesSignals: signals,
    sentimentCue: sentiment,
    sentimentConfidence: sentiment === 'unknown' ? 'low' : output.sentimentConfidence,
    ...(output.nextAction && nextActionEvidence.length ? { nextAction: output.nextAction } : {}),
    ...(output.nextActionDue && output.nextAction && nextActionEvidence.length && explicitlyEvidencedDate(output.nextActionDue, nextActionEvidence) ? { nextActionDue: output.nextActionDue } : {}),
    nextActionEvidence: output.nextAction && nextActionEvidence.length ? nextActionEvidence : [],
    coachingSignals
  };
}

export class OpenAIConversationAnalyzer {
  private readonly client: OpenAI | undefined;
  readonly model: string;

  constructor(options: { apiKey?: string; model?: string; timeoutMs?: number } = {}) {
    const apiKey = options.apiKey?.trim() || Bun.env.OPENAI_API_KEY?.trim();
    this.model = options.model?.trim() || Bun.env.OPENAI_ANALYSIS_MODEL?.trim() || OPENAI_CONVERSATION_ANALYSIS_MODEL;
    if (apiKey) this.client = new OpenAI({ apiKey, timeout: options.timeoutMs ?? 120_000 });
  }

  async analyze(turns: RecordingTranscriptTurn[], signal?: AbortSignal): Promise<ConversationAnalysisContent> {
    if (!this.client) throw new ConversationAnalysisError('analysis_not_configured', 'OpenAI analysis is not configured on the API server.', false);
    if (!turns.length) throw new ConversationAnalysisError('transcript_unavailable', 'A diarized transcript is required before conversation analysis.', false);
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'field_sales_conversation_analysis', strict: true, schema: outputSchema }
        },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Analyze this diarized conversation. Segment IDs, speaker IDs, and times are supplied by the transcription pipeline; use these exact values for evidence.\n\n${JSON.stringify(turns)}` }
        ]
      }, { signal });
      const choice = response.choices[0];
      if (!choice || choice.finish_reason !== 'stop') throw new ConversationAnalysisError('analysis_incomplete', 'OpenAI did not complete the structured analysis.', true);
      if (choice.message.refusal) throw new ConversationAnalysisError('analysis_refused', 'OpenAI declined to analyze this conversation.', false);
      if (!choice.message.content) throw new ConversationAnalysisError('analysis_empty', 'OpenAI returned no structured analysis.', true);
      let parsed: unknown;
      try { parsed = JSON.parse(choice.message.content); }
      catch { throw new ConversationAnalysisError('analysis_invalid_output', 'OpenAI returned invalid structured analysis.', true); }
      return validateStructuredConversationAnalysis(parsed, turns);
    } catch (error) {
      if (error instanceof ConversationAnalysisError) throw error;
      if (error instanceof OpenAI.APIError) {
        const status = error.status;
        const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
        throw new ConversationAnalysisError('analysis_provider_error', status ? `OpenAI analysis returned HTTP ${status}.` : 'OpenAI analysis could not be reached.', retryable);
      }
      throw new ConversationAnalysisError('analysis_failed', 'Conversation analysis could not be completed.', true);
    }
  }
}

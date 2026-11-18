import type {
  Confidence,
  InsightCategory,
  InsightExplicitness,
  ManualTranscriptAnalysis,
  ManualTranscriptCoachingSignal,
  ManualTranscriptInsight,
  SentimentCue,
  TranscriptSegment,
  VisitOutcome
} from '@itc/domain';

export interface ManualTranscriptInput {
  id: string;
  createdAt: string;
  conversationDate?: string;
  fileName: string;
  rawTranscript: string;
  outletName: string;
  representativeId: string;
  territoryId: string;
}

interface SignalRule {
  taxonomyKey: string;
  category: InsightCategory;
  title: string;
  patterns: RegExp[];
  suggestedAction?: string;
  summary: string;
}

const signalRules: SignalRule[] = [
  {
    taxonomyKey: 'demand.shopper_request',
    category: 'demand',
    title: 'Shopper demand mentioned',
    patterns: [
      /\b(?:customers?|shoppers?|buyers?)\s+(?:are\s+)?(?:asking|ask|asked|request(?:ed)?|looking for|want|wanted|need|needed)\b/i,
      /\b(?:people|regulars)\s+(?:are\s+)?(?:asking|ask|asked|request(?:ed)?|looking for|want|wanted|need|needed)\b/i,
      /\b(?:moves?|selling|sells?)\s+(?:quickly|well|fast)\b/i,
      /\b(?:popular|high demand|demand is)\b/i
    ],
    summary: 'A direct shopper request or product-movement phrase appears in the transcript.',
    suggestedAction: 'Check the named demand against current outlet stock and the next order.'
  },
  {
    taxonomyKey: 'objection.commercial_or_space',
    category: 'objection',
    title: 'Commercial or space objection',
    patterns: [
      /\btoo\s+(?:expensive|costly|high)\b/i,
      /\b(?:price|pricing|margin|payment cycle|credit window|credit terms?)\b.{0,50}\b(?:tight|low|high|difficult|hard|cannot|can't|won't|not enough|short)\b/i,
      /\b(?:tight|low|difficult|hard|cannot|can't|won't|not enough|short)\b.{0,50}\b(?:price|pricing|margin|payment cycle|credit window|credit terms?)\b/i,
      /\b(?:little|limited|no|not enough)\s+(?:shelf\s+)?(?:space|room)\b/i,
      /\b(?:cannot|can't|won't)\s+(?:fit|take|stock|afford)\b/i,
      /\bnot interested\b/i
    ],
    summary: 'A price, margin, credit, or shelf-space objection is explicitly phrased.',
    suggestedAction: 'Capture the stated constraint and agree on a specific response or escalation.'
  },
  {
    taxonomyKey: 'availability.stock_or_delivery',
    category: 'availability',
    title: 'Availability or delivery issue',
    patterns: [
      /\b(?:out of stock|out since|sold out|no stock|stockout|empty shelf|not available|unavailable)\b/i,
      /\b(?:available|availability|replenish|replenishment|delivery|warehouse|supply)\b/i
    ],
    summary: 'The transcript includes stock, availability, replenishment, or delivery language.',
    suggestedAction: 'Verify stock and delivery timing before confirming an order or visit commitment.'
  },
  {
    taxonomyKey: 'competitor.comparison',
    category: 'competitor',
    title: 'Competitor or alternative mentioned',
    patterns: [
      /\b(?:competitor|competing|rival|other brand|another brand|other company|alternative brand)\b/i,
      /\b(?:Parle|Britannia|Haldiram|Nestle|Amul|Patanjali|Tata Consumer|Mother Dairy|HUL|Hindustan Unilever)\b/i
    ],
    summary: 'A competitor, alternative brand, or known competing brand name appears in the supplied wording.',
    suggestedAction: 'Confirm the exact brand, pack, price, and comparison basis with the outlet.'
  },
  {
    taxonomyKey: 'commitment.next_step',
    category: 'commitment',
    title: 'Follow-up or next step mentioned',
    patterns: [
      /\b(?:call|contact|visit|come|return|check|confirm|send|bring|share|follow up)\b.{0,70}\b(?:tomorrow|today|tonight|later|next|by|on|first|again|back|you|me|the)\b/i,
      /\b(?:please call|call me|come back|next visit|follow up|check back|confirm first|bring it|send me)\b/i
    ],
    summary: 'A follow-up action or next-step phrase is present in the transcript.',
    suggestedAction: 'Record an owner and due date for the next step if the team confirms one.'
  }
];

const productNames = [
  'Dark Fantasy', 'Aashirvaad', 'Sunfeast', 'Bingo', 'YiPPee', 'Yippee', 'Classmate',
  'Mangaldeep', 'Savlon', 'Fiama', 'Engage', 'Vivel', 'B Natural', 'Kitchens of India',
  'Parle', 'Britannia', 'Haldiram', 'Nestle', 'Amul', 'Patanjali', 'Mother Dairy'
];

const sentimentRules: Array<{ cue: Exclude<SentimentCue, 'unknown'>; pattern: RegExp }> = [
  { cue: 'at_risk', pattern: /\b(?:disappointed|frustrat(?:ed|ing)|unhappy|will stop|won't buy|will not buy|switch(?:ing)?|lost sales|no longer|too expensive)\b/i },
  { cue: 'hesitant', pattern: /\b(?:maybe|not sure|need to think|think about it|consider|if it can|if you can|could be|might|before i decide|after i know)\b/i },
  { cue: 'positive', pattern: /\b(?:great|excellent|happy|satisfied|works well|selling well|moves quickly|good margin|good price|very good)\b/i },
  { cue: 'neutral', pattern: /\b(?:okay|ok|all right|alright|that is fine|fine with me)\b/i }
];

const speakerLabels: Array<{ speaker: Exclude<TranscriptSegment['speaker'], 'unknown'>; pattern: RegExp }> = [
  { speaker: 'representative', pattern: /^(?:representative|sales representative|sales rep|field rep|rep|salesperson)$/i },
  { speaker: 'shopkeeper', pattern: /^(?:shopkeeper|shop owner|store owner|retailer|customer|buyer)$/i }
];

interface ParsedSpeakerLine {
  speaker: TranscriptSegment['speaker'];
  text: string;
}

function speakerFromLabel(label: string): TranscriptSegment['speaker'] {
  const match = speakerLabels.find((candidate) => candidate.pattern.test(label.trim()));
  return match?.speaker ?? 'unknown';
}

function parseSpeakerLine(line: string, stripMarkup = false): ParsedSpeakerLine {
  let text = line.trimStart();
  let speaker: TranscriptSegment['speaker'] = 'unknown';

  // WebVTT voice spans annotate a speaker without changing the spoken words.
  const voiceMatch = stripMarkup ? text.match(/^<v(?:\.[^\s>]+)?\s+([^>]+)>([\s\S]*?)<\/v>\s*$/i) : null;
  if (voiceMatch) {
    speaker = speakerFromLabel(voiceMatch[1] ?? '');
    text = voiceMatch[2] ?? '';
  }

  // Remove presentation markup while retaining the supplied words verbatim.
  if (stripMarkup) text = text.replace(/<[^>]+>/g, '');
  const labelMatch = text.match(/^\s*(representative|sales representative|sales rep|field rep|rep|salesperson|shopkeeper|shop owner|store owner|retailer|customer|buyer)\s*[:\-–]\s?(.*)$/i);
  if (labelMatch) {
    speaker = speakerFromLabel(labelMatch[1] ?? '');
    text = labelMatch[2] ?? '';
  }
  return { speaker, text };
}

interface CueTiming {
  startMs: number;
  endMs: number;
}

function timestampToMs(value: string): number | undefined {
  const match = value.match(/^(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return undefined;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (minutes > 59 || seconds > 59) return undefined;
  return (((hours * 60 + minutes) * 60 + seconds) * 1000) + milliseconds;
}

function parseCueTiming(line: string): CueTiming | undefined {
  const match = line.match(/^\s*((?:\d+:)?\d{2}:\d{2}[,.]\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[,.]\d{3})(?:\s+.*)?\s*$/);
  if (!match) return undefined;
  const startMs = timestampToMs(match[1] ?? '');
  const endMs = timestampToMs(match[2] ?? '');
  if (startMs === undefined || endMs === undefined || endMs < startMs) return undefined;
  return { startMs, endMs };
}

function hasCueArrow(line: string): boolean {
  return /^\s*[\d:.,]+\s+-->\s*[\d:.,]+/.test(line);
}

function parseSubtitleTranscript(rawTranscript: string): TranscriptSegment[] {
  const blocks = rawTranscript.split(/\r?\n\s*\r?\n/);
  const transcript: TranscriptSegment[] = [];
  let cueNumber = 0;

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const first = lines[0]?.trim() ?? '';
    const timingIndex = lines.findIndex(hasCueArrow);
    if (timingIndex < 0) continue;
    if (/^(?:NOTE\b|STYLE\b|REGION\b)/i.test(first)) continue;
    cueNumber += 1;
    const timing = parseCueTiming(lines[timingIndex] ?? '');
    const textLines = lines.slice(timingIndex + 1).filter((line) => line.trim());

    textLines.forEach((line, lineIndex) => {
      const parsed = parseSpeakerLine(line, true);
      if (!parsed.text.trim()) return;
      transcript.push({
        id: `cue-${cueNumber}-line-${lineIndex + 1}`,
        speaker: parsed.speaker,
        text: parsed.text,
        ...(timing ? { startMs: timing.startMs, endMs: timing.endMs } : {})
      });
    });
  }
  return transcript;
}

function parsePlainTranscript(rawTranscript: string): TranscriptSegment[] {
  return rawTranscript.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    const parsed = parseSpeakerLine(line);
    if (!parsed.text.trim()) return [];
    return [{ id: `line-${index + 1}`, speaker: parsed.speaker, text: parsed.text }];
  });
}

export function parseManualTranscript(rawTranscript: string, fileName?: string): TranscriptSegment[] {
  const subtitleFile = /\.(?:srt|vtt)$/i.test(fileName ?? '')
    || /^\s*WEBVTT\b/im.test(rawTranscript)
    || rawTranscript.split(/\r?\n/).some(hasCueArrow);
  if (!subtitleFile) return parsePlainTranscript(rawTranscript);
  if (rawTranscript.split(/\r?\n/).some(hasCueArrow)) return parseSubtitleTranscript(rawTranscript);
  const untimedText = rawTranscript.split(/\r?\n/).filter((line) =>
    !/^\s*(?:WEBVTT\b|NOTE\b|STYLE\b|REGION\b|Kind:.*|Language:.*|\d+)\s*$/i.test(line)
  ).join('\n');
  return parsePlainTranscript(untimedText);
}

function isHedged(text: string): boolean {
  return /\b(?:maybe|not sure|think|if|might|could|would|possibly|uncertain)\b/i.test(text);
}

function makeInsights(transcript: TranscriptSegment[]): ManualTranscriptInsight[] {
  const insights: ManualTranscriptInsight[] = [];
  for (const rule of signalRules) {
    const matches = transcript.filter((segment) => rule.patterns.some((pattern) => pattern.test(segment.text)));
    if (!matches.length) continue;
    const explicitness: InsightExplicitness = matches.some((segment) => isHedged(segment.text)) ? 'uncertain' : 'explicit';
    const confidence: Confidence = matches.every((segment) => segment.speaker === 'shopkeeper' && !isHedged(segment.text))
      ? 'high'
      : matches.some((segment) => segment.speaker === 'unknown') || explicitness === 'uncertain'
        ? 'low'
        : 'medium';
    insights.push({
      id: `insight-${rule.taxonomyKey.replace(/[^a-z0-9]+/gi, '-')}`,
      category: rule.category,
      title: rule.title,
      summary: `${rule.summary} Matched ${matches.length} transcript line${matches.length === 1 ? '' : 's'}.`,
      confidence,
      evidence: matches.map((segment) => ({ segmentIds: [segment.id], quote: segment.text })),
      suggestedAction: rule.suggestedAction,
      taxonomyKey: rule.taxonomyKey,
      mentionCount: matches.length,
      explicitness
    });
  }

  const sentimentMatches = transcript.flatMap((segment) => {
    if (segment.speaker !== 'shopkeeper') return [];
    const rule = sentimentRules.find((candidate) => candidate.pattern.test(segment.text));
    return rule ? [{ segment, cue: rule.cue }] : [];
  });
  if (sentimentMatches.length) {
    const cueCounts = new Map<SentimentCue, number>();
    for (const match of sentimentMatches) cueCounts.set(match.cue, (cueCounts.get(match.cue) ?? 0) + 1);
    const [dominantCue] = [...cueCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    const explicitness: InsightExplicitness = sentimentMatches.some(({ segment }) => isHedged(segment.text)) ? 'uncertain' : 'explicit';
    const confidence: Confidence = sentimentMatches.some(({ segment }) => segment.speaker === 'unknown')
      ? 'low'
      : explicitness === 'uncertain'
        ? 'low'
        : sentimentMatches.every(({ segment }) => segment.speaker === 'shopkeeper')
          ? 'medium'
          : 'low';
    insights.push({
      id: 'insight-sentiment-cue',
      category: 'sentiment',
      title: `Conversation tone: ${dominantCue.replace('_', ' ')}`,
      summary: `Rule-based sentiment cues were found in ${sentimentMatches.length} line${sentimentMatches.length === 1 ? '' : 's'}; this is a text cue, not an audio emotion reading.`,
      confidence,
      evidence: sentimentMatches.map(({ segment }) => ({ segmentIds: [segment.id], quote: segment.text })),
      taxonomyKey: 'sentiment.text_cue',
      mentionCount: sentimentMatches.length,
      explicitness
    });
  }
  return insights;
}

function inferOutcome(transcript: TranscriptSegment[]): {
  outcome: VisitOutcome;
  evidenceIds: string[];
  orderAmount?: number;
  nextAction?: string;
  nextActionEvidenceIds?: string[];
} {
  const shopkeeperLines = transcript.filter((segment) => segment.speaker === 'shopkeeper');
  const representativeLines = transcript.filter((segment) => segment.speaker === 'representative');
  const orderLine = shopkeeperLines.find((segment) => {
    const text = segment.text;
    if (/\b(?:if|maybe|might|could|would|not sure|before i decide)\b/i.test(text)) return false;
    return /\b(?:yes[, ]+)?(?:please\s+)?(?:add|book|include|put)\b.{0,70}\b(?:order|case|carton|pack|stock|it|them|these|those)\b/i.test(text)
      || /\b(?:i(?:'ll| will) take|we(?:'ll| will) take|place an order|i want to order|let(?:'s| us) order|order confirmed)\b/i.test(text);
  });
  const noOrderLine = shopkeeperLines.find((segment) => /\b(?:no order(?: today| now)?|not ordering|do not place|don't place|do not book|don't book|no stock order)\b/i.test(segment.text));
  const followUpLine = shopkeeperLines.find((segment) => /\b(?:please call|call me|come back|next visit|follow up|check back|confirm first|bring (?:it|that|those)|send me)\b/i.test(segment.text));
  const conditionalOrderLine = shopkeeperLines.find((segment) =>
    /\b(?:if|when)\b.{0,90}\b(?:i(?:'ll| will) take|we(?:'ll| will) take|can take|would take)\b/i.test(segment.text)
  );
  const representativeCommitmentLine = representativeLines.find((segment) =>
    /^\s*(?:(?:i|we)(?:'ll| will)|let me)\b/i.test(segment.text)
    && /\b(?:call|contact|visit|come|return|check|confirm|send|bring|share|follow up|deliver|replenish|meet|talk|reach out|be in touch)\b/i.test(segment.text)
  );
  const nextActionSegment = followUpLine ?? representativeCommitmentLine ?? conditionalOrderLine;

  if (orderLine && (!noOrderLine || orderLine.id !== noOrderLine.id)) {
    const amountEvidence = explicitOrderAmount(transcript);
    return {
      outcome: 'order_placed',
      evidenceIds: [...new Set([orderLine.id, ...(amountEvidence ? [amountEvidence.segmentId] : [])])],
      ...(amountEvidence ? { orderAmount: amountEvidence.amount } : {}),
      ...(nextActionSegment ? { nextAction: nextActionSegment.text, nextActionEvidenceIds: [nextActionSegment.id] } : {})
    };
  }
  if (nextActionSegment) {
    return {
      outcome: 'follow_up',
      evidenceIds: [nextActionSegment.id],
      nextAction: nextActionSegment.text,
      nextActionEvidenceIds: [nextActionSegment.id]
    };
  }
  if (noOrderLine) return { outcome: 'no_order', evidenceIds: [noOrderLine.id] };
  return { outcome: 'not_stated', evidenceIds: [] };
}

function explicitOrderAmount(transcript: TranscriptSegment[]): { amount: number; segmentId: string } | undefined {
  const amountLine = transcript.find((segment) =>
    /\b(?:order\s+)?(?:total|grand total|order value|amount)\b/i.test(segment.text)
    && /(?:₹|\b(?:INR|Rs\.?|rupees?)\s*)[\s,]*\d[\d,]*(?:\.\d{1,2})?/i.test(segment.text)
  );
  if (!amountLine) return undefined;
  const match = amountLine.text.match(/(?:₹|\b(?:INR|Rs\.?|rupees?)\s*)[\s,]*(\d[\d,]*(?:\.\d{1,2})?)/i);
  if (!match?.[1]) return undefined;
  const amount = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(amount) && amount >= 0 ? { amount, segmentId: amountLine.id } : undefined;
}

function inferNextActionDue(nextAction: string | undefined, conversationDate: string | undefined): string | undefined {
  if (!nextAction || !conversationDate) return undefined;
  const sourceDateMatch = conversationDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!sourceDateMatch) return undefined;
  const year = Number(sourceDateMatch[1]);
  const month = Number(sourceDateMatch[2]);
  const day = Number(sourceDateMatch[3]);
  const anchor = new Date(Date.UTC(year, month - 1, day));
  if (anchor.getUTCFullYear() !== year || anchor.getUTCMonth() !== month - 1 || anchor.getUTCDate() !== day) return undefined;

  // Conditions describe an opportunity, not necessarily an agreed follow-up date.
  if (/^\s*if\b/i.test(nextAction) || /\bif\b.{0,80}\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(nextAction)) {
    return undefined;
  }
  const action = /\b(?:call|contact|visit|come|return|check|confirm|send|bring|share|follow up|deliver|replenish|meet|talk|reach out|be in touch)\b/i.exec(nextAction);
  if (!action) return undefined;
  const negatedAction = /\b(?:do not|don't|will not|won't|never|not)\b.{0,30}\b(?:call|contact|visit|come|return|check|confirm|send|bring|share|follow up|deliver|replenish|meet|talk|reach out|be in touch)\b/i.test(nextAction);
  if (negatedAction) return undefined;

  const relativeDates = /\b(?:(next|this)\s+)?(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
  const candidates: string[] = [];
  for (const match of nextAction.matchAll(relativeDates)) {
    const matchedDate = match[2]?.toLowerCase();
    const modifier = match[1]?.toLowerCase();
    const phraseIndex = match.index ?? 0;
    if (!matchedDate || Math.abs(action.index - phraseIndex) > 100) continue;

    let offset: number;
    if (matchedDate === 'today') {
      if (modifier) continue;
      offset = 0;
    } else if (matchedDate === 'tomorrow') {
      if (modifier) continue;
      offset = 1;
    } else {
      const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const targetDay = weekdays.indexOf(matchedDate);
      const daysAhead = (targetDay - anchor.getUTCDay() + 7) % 7;
      offset = modifier === 'next' && daysAhead === 0 ? 7 : daysAhead;
    }

    const due = new Date(anchor.getTime() + offset * 24 * 60 * 60 * 1000);
    candidates.push(due.toISOString().slice(0, 10));
  }
  const uniqueCandidates = [...new Set(candidates)];
  // Do not choose between multiple different dates stated for the same action.
  return uniqueCandidates.length === 1 ? uniqueCandidates[0] : undefined;
}

function inferSentiment(transcript: TranscriptSegment[]): { cue: SentimentCue; confidence: Confidence } {
  const matches = transcript.flatMap((segment) => {
    if (segment.speaker !== 'shopkeeper') return [];
    const rule = sentimentRules.find((candidate) => candidate.pattern.test(segment.text));
    return rule ? [rule.cue] : [];
  });
  if (!matches.length) return { cue: 'unknown', confidence: 'low' };
  const counts = new Map<SentimentCue, number>();
  for (const cue of matches) counts.set(cue, (counts.get(cue) ?? 0) + 1);
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  return { cue: dominant, confidence: matches.length > 1 ? 'medium' : 'low' };
}

function coachingSignals(transcript: TranscriptSegment[]): ManualTranscriptCoachingSignal[] {
  const signals: ManualTranscriptCoachingSignal[] = [];
  const repLines = transcript.filter((segment) => segment.speaker === 'representative');
  const discovery = repLines.filter((segment) => /\?/.test(segment.text) && /\b(?:what|how|which|when|where|why|who|do|does|did|can|could|would|are|is)\b/i.test(segment.text));
  if (discovery.length) signals.push({
    rubricKey: 'discovery',
    label: 'Asked a discovery question',
    confidence: 'medium',
    evidenceSegmentIds: discovery.map((segment) => segment.id),
    note: 'Rule-based cue: representative lines contain an interrogative question. This does not judge question quality.'
  });

  const benefitLines = repLines.filter((segment) => /\b(?:benefit|helps?|because|faster|better|more|saves?|improves?|value|margin|shelf|display)\b/i.test(segment.text));
  if (benefitLines.length) signals.push({
    rubricKey: 'benefit_explanation',
    label: 'Explained a product or commercial point',
    confidence: 'low',
    evidenceSegmentIds: benefitLines.map((segment) => segment.id),
    note: 'Rule-based cue: representative wording includes a benefit or commercial term; no quality score is implied.'
  });

  const objectionLines = transcript.filter((segment) => segment.speaker === 'shopkeeper' && signalRules[1]!.patterns.some((pattern) => pattern.test(segment.text)));
  const respondedLines = repLines.filter((segment) => objectionLines.some((objection) => transcript.indexOf(segment) > transcript.indexOf(objection)));
  if (objectionLines.length && respondedLines.length) signals.push({
    rubricKey: 'objection_response',
    label: 'Responded after an objection cue',
    confidence: 'low',
    evidenceSegmentIds: [objectionLines[0]!.id, respondedLines[0]!.id],
    note: 'Rule-based sequence cue only: a representative line follows an objection phrase; the response is not assessed.'
  });

  const closeLines = repLines.filter((segment) => /\b(?:order|book|add|take|next step|call|visit|come back|follow up|confirm)\b/i.test(segment.text));
  if (closeLines.length) signals.push({
    rubricKey: 'close_or_next_step',
    label: 'Raised an order or next step',
    confidence: 'medium',
    evidenceSegmentIds: closeLines.map((segment) => segment.id),
    note: 'Rule-based cue: representative wording mentions an order action or next step.'
  });
  return signals;
}

function detectProducts(transcript: TranscriptSegment[]): string[] {
  const text = transcript.map((segment) => segment.text).join('\n');
  return productNames.filter((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
}

function reportSummary(insights: ManualTranscriptInsight[], outcome: VisitOutcome): string {
  const categories = [...new Set(insights.map((insight) => insight.category))];
  const outcomeText: Record<VisitOutcome, string> = {
    order_placed: 'explicit order language found',
    follow_up: 'follow-up language found',
    no_order: 'explicit no-order language found',
    new_outlet: 'new-outlet status is explicit',
    not_stated: 'outcome not stated'
  };
  if (!insights.length) return `Manual transcript rule review: no supported sales signals were found; ${outcomeText[outcome]}.`;
  return `Manual transcript rule review: ${insights.length} signal categories found (${categories.join(', ')}); ${outcomeText[outcome]}.`;
}

export function analyzeManualTranscript(input: ManualTranscriptInput): Omit<ManualTranscriptAnalysis, 'storageState' | 'objectKey'> {
  const transcript = parseManualTranscript(input.rawTranscript, input.fileName);
  const insights = makeInsights(transcript);
  const inferredOutcome = inferOutcome(transcript);
  const sentiment = inferSentiment(transcript);
  const nextActionDue = inferNextActionDue(inferredOutcome.nextAction, input.conversationDate);
  return {
    source: 'manual_transcript',
    id: input.id,
    createdAt: input.createdAt,
    ...(input.conversationDate ? { conversationDate: input.conversationDate } : {}),
    fileName: input.fileName,
    rawTranscript: input.rawTranscript,
    outletName: input.outletName,
    representativeId: input.representativeId,
    territoryId: input.territoryId,
    outcome: inferredOutcome.outcome,
    outcomeEvidenceSegmentIds: inferredOutcome.evidenceIds,
    ...(inferredOutcome.orderAmount === undefined ? {} : { confirmedOrderValueInr: inferredOutcome.orderAmount }),
    sentimentCue: sentiment.cue,
    sentimentConfidence: sentiment.confidence,
    summary: reportSummary(insights, inferredOutcome.outcome),
    ...(inferredOutcome.nextAction ? { nextAction: inferredOutcome.nextAction } : {}),
    ...(inferredOutcome.nextActionEvidenceIds ? { nextActionEvidenceSegmentIds: inferredOutcome.nextActionEvidenceIds } : {}),
    ...(nextActionDue ? { nextActionDue } : {}),
    productsDiscussed: detectProducts(transcript),
    transcript,
    insights,
    coachingSignals: coachingSignals(transcript)
  };
}

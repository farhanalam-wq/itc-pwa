import { expect, test } from 'bun:test';
import type { RecordingTranscriptTurn } from '@itc/domain';
import { validateStructuredConversationAnalysis } from './openai-conversation-analysis';

const turns: RecordingTranscriptTurn[] = [
  { id: 'seg-rep', speaker: 'Speaker 1', startMs: 0, endMs: 900, text: 'I can add two cases to today’s order.', overlapsSpeech: false },
  { id: 'seg-retailer', speaker: 'Speaker 2', startMs: 1000, endMs: 1800, text: 'Yes, add two cases to today’s order. The total is ₹240.', overlapsSpeech: false }
];

function evidence(segmentId: string, quote: string) {
  const turn = turns.find((item) => item.id === segmentId)!;
  return { segmentIds: [segmentId], quote, startMs: turn.startMs, endMs: turn.endMs };
}

function modelOutput() {
  return {
    speakerRoles: [
      { speaker: 'Speaker 1', role: 'representative' },
      { speaker: 'Speaker 2', role: 'shopkeeper' }
    ],
    outcome: 'order_placed', outcomeConfidence: 'high', outcomeExplicitness: 'explicit',
    outcomeEvidence: [evidence('seg-retailer', 'Yes, add two cases to today’s order.')], summary: 'The retailer agreed to two cases.',
    confirmedOrders: [{
      id: 'order-1', intent: 'confirmed', productName: 'biscuit cases', brand: null, packDescription: null,
      quantity: 2, quantityUnit: 'cases', unitPriceInr: null, totalValueInr: null, confidence: 'high',
      evidence: [evidence('seg-retailer', 'Yes, add two cases to today’s order.')], retailerAssentSpeaker: 'Speaker 2'
    }],
    salesSignals: [{
      id: 'signal-1', category: 'demand', taxonomyKey: 'shopper_requests', title: 'Shopper demand', summary: 'Retailer reports demand.', confidence: 'medium',
      evidence: [evidence('seg-retailer', 'Yes, add two cases to today’s order.')], suggestedAction: null,
      explicitness: 'explicit', mentionCount: 1, productName: null, brand: null, packDescription: null,
      explicitCount: null, countUnit: null, status: 'reported'
    }],
    sentimentCue: 'neutral', sentimentConfidence: 'low', nextAction: null, nextActionDue: null,
    nextActionEvidence: [], coachingSignals: []
  };
}

test('retains a confirmed order only when cited evidence is a diarized shopkeeper turn', () => {
  const result = validateStructuredConversationAnalysis(modelOutput(), turns);
  expect(result.confirmedOrders[0]?.intent).toBe('confirmed');
  expect(result.confirmedOrders[0]?.evidence[0]?.segmentIds).toEqual(['seg-retailer']);
});

test('demotes a proposal-only representative turn even when the model calls it confirmed', () => {
  const output = modelOutput();
  output.confirmedOrders[0]!.evidence = [evidence('seg-rep', 'I can add two cases to today’s order.')];
  output.confirmedOrders[0]!.retailerAssentSpeaker = 'Speaker 1';
  const result = validateStructuredConversationAnalysis(output, turns);
  expect(result.confirmedOrders[0]?.intent).toBe('unknown');
  expect(result.outcome).toBe('not_stated');
});

test('demotes confirmed orders when speaker roles are ambiguous', () => {
  const output = modelOutput();
  output.speakerRoles[0]!.role = 'shopkeeper';
  const result = validateStructuredConversationAnalysis(output, turns);
  expect(result.confirmedOrders[0]?.intent).toBe('unknown');
  expect(result.outcome).toBe('not_stated');
});

test('keeps only retailer-stated total values and never calculates order value from quantity', () => {
  const calculated: any = modelOutput();
  calculated.confirmedOrders[0]!.quantity = 2;
  calculated.confirmedOrders[0]!.unitPriceInr = 120;
  calculated.confirmedOrders[0]!.totalValueInr = 240;
  expect(validateStructuredConversationAnalysis(calculated, turns).confirmedOrders[0]?.totalValueInr).toBeUndefined();

  const stated: any = modelOutput();
  stated.confirmedOrders[0]!.totalValueInr = 240;
  stated.confirmedOrders[0]!.evidence = [evidence('seg-retailer', 'The total is ₹240.')];
  expect(validateStructuredConversationAnalysis(stated, turns).confirmedOrders[0]?.totalValueInr).toBe(240);

  const noCurrency: any = modelOutput();
  noCurrency.confirmedOrders[0]!.totalValueInr = 2;
  noCurrency.confirmedOrders[0]!.evidence = [evidence('seg-retailer', 'The total is 2 cases.')];
  expect(validateStructuredConversationAnalysis(noCurrency, turns).confirmedOrders[0]?.totalValueInr).toBeUndefined();
});

test('keeps only valid ISO follow-up dates present in the cited quote', () => {
  const datedTurns = [...turns, {
    id: 'seg-date', speaker: 'Speaker 2', startMs: 2000, endMs: 2500,
    text: 'Call me on 2026-11-30.', overlapsSpeech: false
  } satisfies RecordingTranscriptTurn];
  const output: any = modelOutput();
  output.nextAction = 'Call retailer';
  output.nextActionDue = '2026-11-30';
  output.nextActionEvidence = [{ segmentIds: ['seg-date'], quote: 'Call me on 2026-11-30.', startMs: 2000, endMs: 2500 }];
  expect(validateStructuredConversationAnalysis(output, datedTurns).nextActionDue).toBe('2026-11-30');

  output.nextActionDue = '2026-02-30';
  expect(validateStructuredConversationAnalysis(output, datedTurns).nextActionDue).toBeUndefined();

  output.nextActionDue = '2026-11-29';
  expect(validateStructuredConversationAnalysis(output, datedTurns).nextActionDue).toBeUndefined();

  output.outcome = 'follow_up';
  output.outcomeEvidence = [evidence('seg-retailer', 'Yes, add two cases to today’s order.')];
  output.nextAction = null;
  output.nextActionEvidence = [];
  expect(validateStructuredConversationAnalysis(output, turns).outcome).toBe('not_stated');
});

test('drops findings with unknown speakers or unsupported quote evidence', () => {
  const output = modelOutput();
  output.speakerRoles[1]!.role = 'unknown';
  output.salesSignals[0]!.evidence = [evidence('seg-retailer', 'The retailer ordered ten cases.')];
  const result = validateStructuredConversationAnalysis(output, turns);
  expect(result.outcome).toBe('not_stated');
  expect(result.confirmedOrders[0]?.intent).toBe('unknown');
  expect(result.salesSignals).toHaveLength(0);
});

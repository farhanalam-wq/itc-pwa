import type {
  Confidence,
  ConversationInsight,
  InsightCategory,
  TranscriptSegment,
  VisitOutcome
} from '@itc/domain';

export const demoDataMode = 'synthetic' as const;
export const demoDataNotice =
  'Synthetic demonstration data. These conversations, people, outlets, and figures are fictional; no audio is attached.';

export type InsightExplicitness = 'explicit' | 'inferred' | 'uncertain';
export type ConversationCue = 'positive' | 'neutral' | 'hesitant' | 'at_risk';

export interface DemoInsight extends ConversationInsight {
  taxonomyKey: string;
  /** Number of supported mentions in this visit; aggregate separately from visit prevalence. */
  mentionCount: number;
  explicitness: InsightExplicitness;
}

export interface DemoCoachingSignal {
  rubricKey: 'discovery' | 'benefit_explanation' | 'objection_response' | 'close_or_next_step';
  label: string;
  confidence: Confidence;
  evidenceSegmentIds: string[];
  note: string;
}

export interface DemoConversation {
  source: typeof demoDataMode;
  id: string;
  createdAt: string;
  durationSeconds: number;
  representativeId: string;
  representativeName: string;
  representativeInitials: string;
  territoryId: string;
  territoryName: string;
  city: string;
  outletId: string;
  outletName: string;
  outcome: VisitOutcome;
  outcomeEvidenceSegmentIds: string[];
  /** Only set when the transcript explicitly states a confirmed order value. */
  confirmedOrderValueInr?: number;
  sentimentCue: ConversationCue;
  sentimentConfidence: Confidence;
  summary: string;
  nextAction?: string;
  nextActionDue?: string;
  productsDiscussed: string[];
  transcript: TranscriptSegment[];
  insights: DemoInsight[];
  coachingSignals: DemoCoachingSignal[];
}

type SegmentSeed = Omit<TranscriptSegment, 'id'>;

function segment(id: string, speaker: TranscriptSegment['speaker'], startMs: number, endMs: number, text: string, confidence = 0.96): TranscriptSegment {
  return { id, speaker, startMs, endMs, text, confidence };
}

function evidence(segmentIds: string[], quote: string, startMs?: number, endMs?: number) {
  return { segmentIds, quote, startMs, endMs };
}

function insight(
  id: string,
  category: InsightCategory,
  taxonomyKey: string,
  title: string,
  summary: string,
  confidence: Confidence,
  explicitness: InsightExplicitness,
  mentionCount: number,
  segmentIds: string[],
  quote: string,
  suggestedAction?: string,
  startMs?: number,
  endMs?: number
): DemoInsight {
  return {
    id,
    category,
    taxonomyKey,
    title,
    summary,
    confidence,
    explicitness,
    mentionCount,
    evidence: [evidence(segmentIds, quote, startMs, endMs)],
    suggestedAction
  };
}

const v1: SegmentSeed[] = [
  { speaker: 'representative', startMs: 0, endMs: 6700, text: 'I’m recording this visit for sales notes. Is that okay with you?' },
  { speaker: 'shopkeeper', startMs: 7100, endMs: 10200, text: 'Yes, that is fine. We can talk.' },
  { speaker: 'representative', startMs: 18400, endMs: 24700, text: 'Which biscuit packs are customers asking for most this week?' },
  { speaker: 'shopkeeper', startMs: 27300, endMs: 36300, text: 'The five-rupee Dark Fantasy pack moves quickly. Two customers asked for it yesterday.' },
  { speaker: 'representative', startMs: 41200, endMs: 48200, text: 'Let us try two display cases of the five-rupee pack. I can add them to today’s order.' },
  { speaker: 'shopkeeper', startMs: 51400, endMs: 59200, text: 'Yes, add two cases. The total is twelve hundred rupees, right?' },
  { speaker: 'representative', startMs: 62800, endMs: 69100, text: 'Correct, ₹1,200 total. I have added two cases to today’s order.' },
  { speaker: 'shopkeeper', startMs: 73500, endMs: 77100, text: 'Good. Please keep the small packs at the front.' }
];

const v2: SegmentSeed[] = [
  { speaker: 'representative', startMs: 0, endMs: 5400, text: 'How is the Aashirvaad atta shelf looking today?' },
  { speaker: 'shopkeeper', startMs: 8400, endMs: 15200, text: 'The five-kilo pack is out since yesterday. Three people asked for it this morning.' },
  { speaker: 'representative', startMs: 20700, endMs: 26800, text: 'Do you have another pack size that is moving while we replenish that one?' },
  { speaker: 'shopkeeper', startMs: 29700, endMs: 35900, text: 'The one-kilo pack is available, but most of those shoppers want five kilos.' },
  { speaker: 'representative', startMs: 40100, endMs: 47100, text: 'I can check the next delivery slot. Could I call you by four this afternoon?' },
  { speaker: 'shopkeeper', startMs: 50200, endMs: 55600, text: 'Please do. If it can come tomorrow morning, I will take one case.' },
  { speaker: 'representative', startMs: 58900, endMs: 66300, text: 'I will confirm tomorrow’s availability by four and call you back.' },
  { speaker: 'representative', startMs: 68100, endMs: 72400, text: 'Before I go, have customers asked for any small biscuit packs today?' },
  { speaker: 'shopkeeper', startMs: 73900, endMs: 78600, text: 'One customer asked for the five-rupee Dark Fantasy pack this morning.' }
];

const v3: SegmentSeed[] = [
  { speaker: 'representative', startMs: 0, endMs: 5900, text: 'Would another case of Sunfeast biscuits work for this week?' },
  { speaker: 'shopkeeper', startMs: 9700, endMs: 16300, text: 'The margin is tight at the moment, and my payment cycle is seven days. Customers also asked for a five-rupee biscuit pack this week.' },
  { speaker: 'representative', startMs: 20500, endMs: 27800, text: 'What cycle would make it easier to replenish without holding back on stock?' },
  { speaker: 'shopkeeper', startMs: 30900, endMs: 38800, text: 'If the credit window were fourteen days, I could take another case. Seven is difficult before the weekend.' },
  { speaker: 'representative', startMs: 43100, endMs: 49900, text: 'I cannot approve that here. I can ask the area manager about the fourteen-day request.' },
  { speaker: 'shopkeeper', startMs: 53200, endMs: 59600, text: 'Ask first. I will decide after I know whether the cycle can change.' },
  { speaker: 'representative', startMs: 62600, endMs: 69500, text: 'I will ask today and call you tomorrow. No order is being placed now.' }
];

const v4: SegmentSeed[] = [
  { speaker: 'representative', startMs: 0, endMs: 5600, text: 'How are snack sales compared with last week?' },
  { speaker: 'shopkeeper', startMs: 8800, endMs: 16100, text: 'The blue packet from the other company is coming at a lower price, I think around ten rupees.' },
  { speaker: 'representative', startMs: 19900, endMs: 26100, text: 'Do you remember the brand or the exact pack size?' },
  { speaker: 'shopkeeper', startMs: 28800, endMs: 34600, text: 'Not sure of the brand. It was a small blue packet; I did not check the price tag.' },
  { speaker: 'representative', startMs: 39200, endMs: 46300, text: 'I will bring the current Bingo! price list. We can compare the same pack size then.' },
  { speaker: 'shopkeeper', startMs: 49400, endMs: 54800, text: 'Bring that next time. I cannot compare it from memory.' },
  { speaker: 'representative', startMs: 58200, endMs: 64600, text: 'I will bring the list on Friday and check the pack and price with you.' },
  { speaker: 'representative', startMs: 65800, endMs: 68700, text: 'Anything else you would like me to check?' },
  { speaker: 'shopkeeper', startMs: 69900, endMs: 74700, text: 'Two customers asked for the five-rupee Dark Fantasy pack today.' }
];

const v5: SegmentSeed[] = [
  { speaker: 'representative', startMs: 0, endMs: 5200, text: 'What are college customers picking up after class?' },
  { speaker: 'shopkeeper', startMs: 8600, endMs: 15300, text: 'Yippee! noodles sell well then. They ask for the five-rupee small packs, but I have little shelf room.' },
  { speaker: 'representative', startMs: 19400, endMs: 26700, text: 'Would a smaller opening order fit the space you have?' },
  { speaker: 'shopkeeper', startMs: 30100, endMs: 37300, text: 'Yes, I can keep two cartons near the counter for this week.' },
  { speaker: 'representative', startMs: 41200, endMs: 48000, text: 'I can book two cartons and note the counter display request.' },
  { speaker: 'shopkeeper', startMs: 51400, endMs: 57800, text: 'Book two cartons. Please do not send a floor stand; there is no room.' },
  { speaker: 'representative', startMs: 61900, endMs: 68100, text: 'Done, two cartons only, with no floor stand. I have added the order.' }
];

const v6: SegmentSeed[] = [
  { speaker: 'representative', startMs: 0, endMs: 5300, text: 'Would you like to try the new Sunfeast biscuit range in this shop?' },
  { speaker: 'shopkeeper', startMs: 9100, endMs: 16500, text: 'Maybe. Customers ask for five-rupee smaller packs when they are short on cash, but I do not know this range yet.' },
  { speaker: 'representative', startMs: 20400, endMs: 27500, text: 'What would help you feel comfortable trying it?' },
  { speaker: 'shopkeeper', startMs: 30200, endMs: 37400, text: 'A sample and the margin details. I am not saying I will order today.' },
  { speaker: 'representative', startMs: 41700, endMs: 48700, text: 'I will bring a sample and the margin sheet on my next visit.' },
  { speaker: 'shopkeeper', startMs: 52200, endMs: 57600, text: 'Bring those first. Then we can talk about a small trial.' },
  { speaker: 'representative', startMs: 61500, endMs: 68200, text: 'I will return Tuesday with both. Today’s outcome is follow-up, with no order.' }
];

const v7: SegmentSeed[] = [
  { speaker: 'representative', startMs: 0, endMs: 4500, text: 'I’m noting this visit. Is it all right if I record?' },
  { speaker: 'shopkeeper', startMs: 5000, endMs: 7000, text: 'That is fine.' },
  { speaker: 'representative', startMs: 11000, endMs: 17600, text: 'What do shoppers ask for near the counter?' },
  { speaker: 'shopkeeper', startMs: 20500, endMs: 27900, text: 'Two customers asked for the five-rupee Dark Fantasy pack after school yesterday.' },
  { speaker: 'representative', startMs: 32000, endMs: 37500, text: 'Would one case fit the shelf?' },
  { speaker: 'shopkeeper', startMs: 41100, endMs: 47500, text: 'Yes, put one case on today’s order. Six hundred rupees is fine.' },
  { speaker: 'representative', startMs: 50500, endMs: 56700, text: 'I have entered one case for six hundred rupees.' },
  { speaker: 'shopkeeper', startMs: 59400, endMs: 63300, text: 'Okay, put it on the front shelf.' }
];

const v8: SegmentSeed[] = [
  { speaker: 'representative', startMs: 0, endMs: 6100, text: 'How are the small biscuit packs moving this week?' },
  { speaker: 'shopkeeper', startMs: 9200, endMs: 20200, text: 'The five-rupee Dark Fantasy pack has been out since yesterday. Customers asked for it this morning, and it is frustrating to point them to an empty shelf.' },
  { speaker: 'representative', startMs: 25000, endMs: 32200, text: 'Could the next delivery reach before Friday market?' },
  { speaker: 'shopkeeper', startMs: 35900, endMs: 44100, text: 'If you can bring one case before then, I will take it.' },
  { speaker: 'representative', startMs: 48000, endMs: 56100, text: 'I will check the warehouse and call before three this afternoon.' },
  { speaker: 'shopkeeper', startMs: 59500, endMs: 68300, text: 'Please confirm first. Do not book it before the stock is confirmed.' }
];

const v9: SegmentSeed[] = [
  { speaker: 'representative', startMs: 0, endMs: 6000, text: 'Would a smaller biscuit pack work for your regular customers?' },
  { speaker: 'shopkeeper', startMs: 9300, endMs: 18100, text: 'Some shoppers ask for a five-rupee biscuit pack. I need at least fifty paise margin to keep one in front.' },
  { speaker: 'representative', startMs: 22300, endMs: 29700, text: 'Is the credit cycle manageable at that margin?' },
  { speaker: 'shopkeeper', startMs: 33300, endMs: 41400, text: 'Fourteen days would help, but I need to see the written margin before I decide.' },
  { speaker: 'representative', startMs: 45200, endMs: 52600, text: 'I can ask the area manager. I cannot change those terms here.' },
  { speaker: 'shopkeeper', startMs: 55900, endMs: 61200, text: 'Call me Thursday after you check.' },
  { speaker: 'representative', startMs: 64400, endMs: 70600, text: 'I will confirm the approved margin and call Thursday. No order today.' }
];

const v10: SegmentSeed[] = [
  { speaker: 'representative', startMs: 0, endMs: 6000, text: 'How does our snack pack compare with the one beside it?' },
  { speaker: 'shopkeeper', startMs: 9300, endMs: 20500, text: 'The other brand’s twenty-gram pack is marked five rupees. This one is eighteen grams at the same price. One shopper asked for a five-rupee pack with more grams.' },
  { speaker: 'representative', startMs: 24800, endMs: 31000, text: 'Did you check the shelf tags today?' },
  { speaker: 'shopkeeper', startMs: 34600, endMs: 40500, text: 'Yes, I checked them today. I have not checked the net margin.' },
  { speaker: 'representative', startMs: 44400, endMs: 51000, text: 'I will bring the current price and weight sheet.' },
  { speaker: 'shopkeeper', startMs: 54600, endMs: 61200, text: 'Let us compare on Tuesday. Do not change the order today.' },
  { speaker: 'representative', startMs: 64400, endMs: 69100, text: 'I will bring the sheet on Tuesday.' }
];

const v11: SegmentSeed[] = [
  { speaker: 'representative', startMs: 0, endMs: 5700, text: 'How did the breakfast rush go?' },
  { speaker: 'shopkeeper', startMs: 9000, endMs: 18200, text: 'Two customers asked for five-rupee biscuit packs during breakfast. We have been out since yesterday.' },
  { speaker: 'representative', startMs: 22000, endMs: 28500, text: 'Could you take a case if tomorrow’s delivery reaches before eight?' },
  { speaker: 'shopkeeper', startMs: 32300, endMs: 41400, text: 'Maybe one case, if it arrives before eight. I need the usual seven-day credit.' },
  { speaker: 'representative', startMs: 45000, endMs: 52000, text: 'I will check stock and terms with distribution and call by five.' },
  { speaker: 'shopkeeper', startMs: 55200, endMs: 61700, text: 'Please confirm before writing the order.' },
  { speaker: 'representative', startMs: 65200, endMs: 71000, text: 'I will call by five with the availability.' }
];

const v12: SegmentSeed[] = [
  { speaker: 'representative', startMs: 0, endMs: 6200, text: 'What would make a smaller entry pack workable here?' },
  { speaker: 'shopkeeper', startMs: 9400, endMs: 17300, text: 'One customer asked for a five-rupee pack at the counter. I need at least forty paise margin and fifteen days credit.' },
  { speaker: 'representative', startMs: 21100, endMs: 28000, text: 'Is there a competitor offer affecting the shelf decision?' },
  { speaker: 'shopkeeper', startMs: 31600, endMs: 40300, text: 'I heard the competing ten-rupee pack price may change next month, but I have not seen the new list.' },
  { speaker: 'representative', startMs: 44200, endMs: 51600, text: 'I will bring the approved margin sheet and current price list Monday.' },
  { speaker: 'shopkeeper', startMs: 55100, endMs: 61500, text: 'Then I can decide. There is no order today.' },
  { speaker: 'representative', startMs: 64500, endMs: 70600, text: 'I will return Monday with both documents.' }
];

const v13: SegmentSeed[] = [
  { speaker: 'representative', startMs: 0, endMs: 5700, text: 'Are customers asking for any small packs this week?' },
  { speaker: 'shopkeeper', startMs: 9100, endMs: 18400, text: 'Some regulars ask us for the five-rupee Dark Fantasy pack in the evening.' },
  { speaker: 'representative', startMs: 22000, endMs: 28600, text: 'Have you checked the competing blue pack price?' },
  { speaker: 'shopkeeper', startMs: 32100, endMs: 42000, text: 'A rival seller told me ten rupees, but I have not seen the price tag or pack size.' },
  { speaker: 'representative', startMs: 45700, endMs: 52900, text: 'I will bring the price list and compare the same pack size on Friday.' },
  { speaker: 'shopkeeper', startMs: 56300, endMs: 63200, text: 'Please send me the details first. Do not book any stock yet.' },
  { speaker: 'representative', startMs: 66200, endMs: 71800, text: 'I will send the details Friday. No order has been placed.' }
];

const v14: SegmentSeed[] = [
  { speaker: 'representative', startMs: 0, endMs: 5900, text: 'How is the biscuit shelf looking before the school rush?' },
  { speaker: 'shopkeeper', startMs: 9400, endMs: 18800, text: 'One parent asked for the five-rupee Dark Fantasy pack for a school snack. We have been out since Monday.' },
  { speaker: 'representative', startMs: 22600, endMs: 29400, text: 'Could I check the next van for a case?' },
  { speaker: 'shopkeeper', startMs: 33000, endMs: 40500, text: 'Please try for Saturday. The empty shelf has been disappointing.' },
  { speaker: 'representative', startMs: 44300, endMs: 51300, text: 'I will check the van and call tomorrow with the stock status.' },
  { speaker: 'shopkeeper', startMs: 54800, endMs: 62000, text: 'If it is available Saturday, I can take one case.' },
  { speaker: 'representative', startMs: 65500, endMs: 72000, text: 'I will confirm first. No case is booked yet.' }
];

function withSegmentIds(visitId: string, seeds: SegmentSeed[]): TranscriptSegment[] {
  return seeds.map((seed, index) => ({ ...seed, id: visitId + '-s' + (index + 1) }));
}

function sid(visitId: string, index: number): string {
  return visitId + '-s' + index;
}

export const demoConversations: DemoConversation[] = [
  {
    source: 'synthetic',
    id: 'demo-visit-001',
    createdAt: '2026-11-17T10:14:00+05:30',
    durationSeconds: 81,
    representativeId: 'rep-nisha-rao',
    representativeName: 'Nisha Rao',
    representativeInitials: 'NR',
    territoryId: 'territory-bengaluru-east',
    territoryName: 'Bengaluru East',
    city: 'Bengaluru',
    outletId: 'outlet-riverbend-kirana',
    outletName: 'Riverbend Kirana',
    outcome: 'order_placed',
    outcomeEvidenceSegmentIds: [sid('demo-visit-001', 6), sid('demo-visit-001', 7)],
    confirmedOrderValueInr: 1200,
    sentimentCue: 'positive',
    sentimentConfidence: 'high',
    summary: 'Shopkeeper confirmed two cases of the ₹5 Dark Fantasy pack for ₹1,200 and asked to place the packs at the front.',
    productsDiscussed: ['Sunfeast Dark Fantasy, ₹5 pack'],
    transcript: withSegmentIds('demo-visit-001', v1),
    insights: [
      insight('demo-i-001-a', 'demand', 'demand.small-pack-five-rupees', 'Demand for ₹5 entry pack', 'Shopkeeper reports two customer requests for the ₹5 pack yesterday and confirms a two-case trial order.', 'high', 'explicit', 2, [sid('demo-visit-001', 4)], 'The five-rupee Dark Fantasy pack moves quickly. Two customers asked for it yesterday.', 'Track repeat order after the trial.', 27300, 36300),
      insight('demo-i-001-b', 'commitment', 'commitment.confirmed-order', 'Two cases confirmed', 'A two-case order and total value are both stated explicitly.', 'high', 'explicit', 1, [sid('demo-visit-001', 6), sid('demo-visit-001', 7)], 'Yes, add two cases. The total is twelve hundred rupees, right?', undefined, 51400, 59200),
      insight('demo-i-001-c', 'conversation_quality', 'quality.discovery-question', 'Rep asked about customer demand', 'The rep asked which packs customers requested before proposing the trial.', 'high', 'explicit', 1, [sid('demo-visit-001', 3)], 'Which biscuit packs are customers asking for most this week?', undefined, 18400, 24700)
    ],
    coachingSignals: [
      { rubricKey: 'discovery', label: 'Asked about current customer requests', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-001', 3), sid('demo-visit-001', 4)], note: 'Question and retailer response are both present.' },
      { rubricKey: 'close_or_next_step', label: 'Confirmed quantity and value', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-001', 6), sid('demo-visit-001', 7)], note: 'Retailer confirmed two cases and the stated total.' }
    ]
  },
  {
    source: 'synthetic',
    id: 'demo-visit-002',
    createdAt: '2026-11-17T11:02:00+05:30',
    durationSeconds: 79,
    representativeId: 'rep-rohan-kulkarni',
    representativeName: 'Rohan Kulkarni',
    representativeInitials: 'RK',
    territoryId: 'territory-mysuru-north',
    territoryName: 'Mysuru North',
    city: 'Mysuru',
    outletId: 'outlet-lakeview-provisions',
    outletName: 'Lakeview Provisions',
    outcome: 'follow_up',
    outcomeEvidenceSegmentIds: [sid('demo-visit-002', 6), sid('demo-visit-002', 7)],
    sentimentCue: 'hesitant',
    sentimentConfidence: 'medium',
    summary: 'Five-kilo Aashirvaad atta is out of stock. Shopkeeper will take one case if tomorrow morning delivery is confirmed.',
    nextAction: 'Confirm tomorrow-morning availability and call the outlet.',
    nextActionDue: '2026-11-17T16:00:00+05:30',
    productsDiscussed: ['Aashirvaad atta, 1 kg pack', 'Aashirvaad atta, 5 kg pack', 'Sunfeast Dark Fantasy, ₹5 pack'],
    transcript: withSegmentIds('demo-visit-002', v2),
    insights: [
      insight('demo-i-002-a', 'availability', 'availability.stockout-five-kilo', '5 kg pack out of stock', 'Shopkeeper says the pack has been unavailable since yesterday and reports three requests this morning.', 'high', 'explicit', 2, [sid('demo-visit-002', 2), sid('demo-visit-002', 4)], 'The five-kilo pack is out since yesterday. Three people asked for it this morning.', 'Check replenishment timing and confirm stock before the next visit.', 8400, 15200),
      insight('demo-i-002-b', 'demand', 'demand.pack-size-five-kilo', 'Preference for 5 kg pack', 'The shopkeeper contrasts available 1 kg stock with customer preference for the 5 kg pack.', 'high', 'explicit', 2, [sid('demo-visit-002', 3), sid('demo-visit-002', 4)], 'The one-kilo pack is available, but most of those shoppers want five kilos.', undefined, 29700, 35900),
      insight('demo-i-002-c', 'commitment', 'commitment.stock-confirmation-call', 'Availability callback agreed for 4 pm', 'Rep commits to calling by 4 pm; shopkeeper states a conditional one-case purchase if next-day delivery is available.', 'high', 'explicit', 1, [sid('demo-visit-002', 5), sid('demo-visit-002', 6), sid('demo-visit-002', 7)], 'If it can come tomorrow morning, I will take one case.', 'Confirm availability by 4 pm; keep the order conditional until confirmed.', 50200, 66300),
      insight('demo-i-002-d', 'demand', 'demand.small-pack-five-rupees', 'One request for a ₹5 entry pack', 'One customer request for a small biscuit pack was reported; it is not an order.', 'medium', 'explicit', 1, [sid('demo-visit-002', 9)], 'One customer asked for the five-rupee Dark Fantasy pack this morning.', undefined, 73900, 78600)
    ],
    coachingSignals: [
      { rubricKey: 'discovery', label: 'Checked alternate pack size', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-002', 3), sid('demo-visit-002', 4)], note: 'Rep explored an available alternative after hearing about the stock-out.' },
      { rubricKey: 'close_or_next_step', label: 'Set a time-bound callback', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-002', 5), sid('demo-visit-002', 7)], note: 'Callback is explicit and due at 4 pm.' }
    ]
  },
  {
    source: 'synthetic',
    id: 'demo-visit-003',
    createdAt: '2026-11-17T12:25:00+05:30',
    durationSeconds: 72,
    representativeId: 'rep-meera-menon',
    representativeName: 'Meera Menon',
    representativeInitials: 'MM',
    territoryId: 'territory-bengaluru-east',
    territoryName: 'Bengaluru East',
    city: 'Bengaluru',
    outletId: 'outlet-greenline-stores',
    outletName: 'Greenline Stores',
    outcome: 'follow_up',
    outcomeEvidenceSegmentIds: [sid('demo-visit-003', 5), sid('demo-visit-003', 7)],
    sentimentCue: 'at_risk',
    sentimentConfidence: 'high',
    summary: 'Retailer cites tight margin and a seven-day payment cycle, asking for fourteen days before deciding on another case. No order was placed.',
    nextAction: 'Ask the area manager about the 14-day credit request and call the retailer tomorrow.',
    nextActionDue: '2026-11-18T17:00:00+05:30',
    productsDiscussed: ['Sunfeast biscuits', 'Sunfeast Dark Fantasy, ₹5 pack'],
    transcript: withSegmentIds('demo-visit-003', v3),
    insights: [
      insight('demo-i-003-a', 'objection', 'objection.credit-cycle-fourteen-days', 'Credit-cycle request: 14 days', 'Shopkeeper compares the current seven-day cycle with a requested fourteen-day cycle and makes a further order conditional on it.', 'high', 'explicit', 2, [sid('demo-visit-003', 2), sid('demo-visit-003', 4)], 'If the credit window were fourteen days, I could take another case. Seven is difficult before the weekend.', 'Route the request through the approved credit process; do not treat it as an order.', 30900, 38800),
      insight('demo-i-003-b', 'objection', 'objection.margin-pressure', 'Margin pressure mentioned', 'Shopkeeper states that margin is tight; no specific margin figure is given.', 'high', 'explicit', 1, [sid('demo-visit-003', 2)], 'The margin is tight at the moment, and my payment cycle is seven days.', undefined, 9700, 16300),
      insight('demo-i-003-c', 'commitment', 'commitment.manager-credit-check', 'Rep will check credit approval', 'Rep agrees to ask the area manager and call tomorrow; retailer will decide after hearing the result.', 'high', 'explicit', 1, [sid('demo-visit-003', 5), sid('demo-visit-003', 6), sid('demo-visit-003', 7)], 'I will ask today and call you tomorrow. No order is being placed now.', 'Capture the manager decision before the callback.', 62600, 69500),
      insight('demo-i-003-d', 'demand', 'demand.small-pack-five-rupees', 'Request for a ₹5 entry pack', 'Retailer reports a request for a small entry pack during the same visit as the margin and credit discussion.', 'medium', 'explicit', 1, [sid('demo-visit-003', 2)], 'Customers also asked for a five-rupee biscuit pack this week.', undefined, 9700, 16300)
    ],
    coachingSignals: [
      { rubricKey: 'objection_response', label: 'Acknowledged approval boundary and offered escalation', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-003', 5)], note: 'Rep did not promise unapproved credit terms.' },
      { rubricKey: 'close_or_next_step', label: 'Agreed a callback, not an order', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-003', 6), sid('demo-visit-003', 7)], note: 'Outcome remains follow-up; order status is explicitly negative.' }
    ]
  },
  {
    source: 'synthetic',
    id: 'demo-visit-004',
    createdAt: '2026-11-17T13:41:00+05:30',
    durationSeconds: 76,
    representativeId: 'rep-aman-verma',
    representativeName: 'Aman Verma',
    representativeInitials: 'AV',
    territoryId: 'territory-hubballi-central',
    territoryName: 'Hubballi Central',
    city: 'Hubballi',
    outletId: 'outlet-station-road-mart',
    outletName: 'Station Road Mart',
    outcome: 'follow_up',
    outcomeEvidenceSegmentIds: [sid('demo-visit-004', 6), sid('demo-visit-004', 7)],
    sentimentCue: 'neutral',
    sentimentConfidence: 'medium',
    summary: 'Retailer recalls a lower-priced blue snack pack but cannot confirm its brand, size, or exact price. Rep will compare verified pack and price details on Friday.',
    nextAction: 'Bring the current Bingo! price list and confirm competitor pack details on Friday.',
    nextActionDue: '2026-11-20T12:00:00+05:30',
    productsDiscussed: ['Bingo! snacks', 'Unnamed competing snack pack', 'Sunfeast Dark Fantasy, ₹5 pack'],
    transcript: withSegmentIds('demo-visit-004', v4),
    insights: [
      insight('demo-i-004-a', 'competitor', 'competitor.unnamed-blue-pack', 'Unverified competitor pack mention', 'Shopkeeper recalls a blue pack but cannot confirm brand, size, or price. Keep the competitor identity unresolved.', 'low', 'uncertain', 1, [sid('demo-visit-004', 2), sid('demo-visit-004', 4)], 'Not sure of the brand. It was a small blue packet; I did not check the price tag.', 'Verify brand, pack size, and shelf price before comparison.', 28800, 34600),
      insight('demo-i-004-b', 'objection', 'objection.competitive-price-pressure-unverified', 'Possible price pressure, unverified', 'A lower price is mentioned from memory; the quoted ₹10 and competing product are not verified facts.', 'low', 'uncertain', 1, [sid('demo-visit-004', 2), sid('demo-visit-004', 4)], 'The blue packet from the other company is coming at a lower price, I think around ten rupees.', undefined, 8800, 16100),
      insight('demo-i-004-c', 'commitment', 'commitment.verified-price-comparison', 'Price-list follow-up set for Friday', 'Rep will bring a current list and check the comparable pack with the retailer.', 'high', 'explicit', 1, [sid('demo-visit-004', 5), sid('demo-visit-004', 7)], 'I will bring the list on Friday and check the pack and price with you.', 'Compare like-for-like packs only after confirming identity and shelf price.', 58200, 64600),
      insight('demo-i-004-d', 'demand', 'demand.small-pack-five-rupees', 'Two requests for a ₹5 entry pack', 'Two retailer-reported customer requests support the entry-pack signal.', 'medium', 'explicit', 2, [sid('demo-visit-004', 9)], 'Two customers asked for the five-rupee Dark Fantasy pack today.', undefined, 69900, 74700)
    ],
    coachingSignals: [
      { rubricKey: 'discovery', label: 'Asked for brand and pack details', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-004', 3), sid('demo-visit-004', 4)], note: 'The retailer could not provide enough detail; the signal remains low confidence.' },
      { rubricKey: 'objection_response', label: 'Deferred comparison until price is verified', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-004', 5), sid('demo-visit-004', 7)], note: 'Rep did not present the recalled ₹10 figure as confirmed.' }
    ]
  },
  {
    source: 'synthetic',
    id: 'demo-visit-005',
    createdAt: '2026-11-17T15:08:00+05:30',
    durationSeconds: 69,
    representativeId: 'rep-devika-shetty',
    representativeName: 'Devika Shetty',
    representativeInitials: 'DS',
    territoryId: 'territory-mysuru-north',
    territoryName: 'Mysuru North',
    city: 'Mysuru',
    outletId: 'outlet-campus-corner',
    outletName: 'Campus Corner',
    outcome: 'order_placed',
    outcomeEvidenceSegmentIds: [sid('demo-visit-005', 6), sid('demo-visit-005', 7)],
    sentimentCue: 'positive',
    sentimentConfidence: 'high',
    summary: 'Shopkeeper confirms two cartons of small YiPPee! noodle packs for a counter placement and explicitly rejects a floor stand because space is limited.',
    productsDiscussed: ['Sunfeast YiPPee! noodles, small pack'],
    transcript: withSegmentIds('demo-visit-005', v5),
    insights: [
      insight('demo-i-005-a', 'demand', 'demand.small-pack-five-rupees', 'Small ₹5 noodle packs requested by students', 'Shopkeeper says college customers request the five-rupee packs; this request does not itself mean they placed an order.', 'high', 'explicit', 1, [sid('demo-visit-005', 2)], 'Yippee! noodles sell well then. They ask for the five-rupee small packs, but I have little shelf room.', 'Check trial sell-through before suggesting a larger order.', 8600, 15300),
      insight('demo-i-005-b', 'availability', 'availability.limited-counter-space', 'Counter space limits display options', 'Retailer accepts a counter placement but explicitly says there is no room for a floor stand.', 'high', 'explicit', 2, [sid('demo-visit-005', 2), sid('demo-visit-005', 6)], 'Book two cartons. Please do not send a floor stand; there is no room.', 'Record the no-floor-stand constraint on the merchandising follow-up.', 51400, 57800),
      insight('demo-i-005-c', 'commitment', 'commitment.confirmed-two-carton-order', 'Two cartons confirmed', 'Retailer agrees to two cartons and rep confirms the order; no order value was stated in the conversation.', 'high', 'explicit', 1, [sid('demo-visit-005', 6), sid('demo-visit-005', 7)], 'Done, two cartons only, with no floor stand. I have added the order.', undefined, 61900, 68100)
    ],
    coachingSignals: [
      { rubricKey: 'discovery', label: 'Asked about shopper behavior', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-005', 1), sid('demo-visit-005', 2)], note: 'Rep asked which shopper group and occasion were relevant.' },
      { rubricKey: 'objection_response', label: 'Adapted the display suggestion to space limits', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-005', 3), sid('demo-visit-005', 6)], note: 'Order is limited to cartons and excludes the floor stand.' }
    ]
  },
  {
    source: 'synthetic',
    id: 'demo-visit-006',
    createdAt: '2026-11-17T16:22:00+05:30',
    durationSeconds: 69,
    representativeId: 'rep-kiran-bhat',
    representativeName: 'Kiran Bhat',
    representativeInitials: 'KB',
    territoryId: 'territory-hubballi-central',
    territoryName: 'Hubballi Central',
    city: 'Hubballi',
    outletId: 'outlet-new-market-kirana',
    outletName: 'New Market Kirana',
    outcome: 'follow_up',
    outcomeEvidenceSegmentIds: [sid('demo-visit-006', 4), sid('demo-visit-006', 7)],
    sentimentCue: 'hesitant',
    sentimentConfidence: 'medium',
    summary: 'Shopkeeper may trial a new range after seeing a sample and margin details. Retailer explicitly says no order today; rep promises a Tuesday return visit.',
    nextAction: 'Bring the product sample and margin sheet on Tuesday.',
    nextActionDue: '2026-11-24T12:00:00+05:30',
    productsDiscussed: ['Sunfeast new range, sample requested'],
    transcript: withSegmentIds('demo-visit-006', v6),
    insights: [
      insight('demo-i-006-a', 'demand', 'demand.small-pack-five-rupees', '₹5 pack interest linked to cash availability', 'Shopkeeper reports that some customers ask for a ₹5 smaller pack when cash is limited; the new range itself is not confirmed and no count of individual shoppers is inferred.', 'medium', 'explicit', 1, [sid('demo-visit-006', 2)], 'Customers ask for five-rupee smaller packs when they are short on cash, but I do not know this range yet.', undefined, 9100, 16500),
      insight('demo-i-006-b', 'objection', 'objection.product-familiarity-and-margin-details', 'Needs product sample and margin details', 'Retailer asks to review a sample and margin details before considering a trial.', 'high', 'explicit', 2, [sid('demo-visit-006', 4), sid('demo-visit-006', 6)], 'A sample and the margin details. I am not saying I will order today.', 'Bring the sample and approved margin information; do not count this as an order.', 30200, 37400),
      insight('demo-i-006-c', 'commitment', 'commitment.sample-return-tuesday', 'Rep agreed to return Tuesday', 'Rep promises a sample and margin sheet on Tuesday; retailer says that will allow a later discussion about a small trial.', 'high', 'explicit', 1, [sid('demo-visit-006', 5), sid('demo-visit-006', 6), sid('demo-visit-006', 7)], 'I will return Tuesday with both. Today’s outcome is follow-up, with no order.', 'Bring both requested materials and revisit trial interest.', 61500, 68200)
    ],
    coachingSignals: [
      { rubricKey: 'discovery', label: 'Asked what would support a trial decision', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-006', 3), sid('demo-visit-006', 4)], note: 'Retailer identified the sample and margin information needed.' },
      { rubricKey: 'close_or_next_step', label: 'Recorded follow-up without implying a sale', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-006', 4), sid('demo-visit-006', 7)], note: 'Outcome is follow-up; order value is intentionally absent.' }
    ]
  },
  {
    source: 'synthetic',
    id: 'demo-visit-007',
    createdAt: '2026-11-18T09:25:00+05:30',
    durationSeconds: 67,
    representativeId: 'rep-nisha-rao',
    representativeName: 'Nisha Rao',
    representativeInitials: 'NR',
    territoryId: 'territory-bengaluru-east',
    territoryName: 'Bengaluru East',
    city: 'Bengaluru',
    outletId: 'outlet-sunrise-corner-shop',
    outletName: 'Sunrise Corner Shop',
    outcome: 'order_placed',
    outcomeEvidenceSegmentIds: [sid('demo-visit-007', 6), sid('demo-visit-007', 7)],
    confirmedOrderValueInr: 600,
    sentimentCue: 'positive',
    sentimentConfidence: 'high',
    summary: 'Two shoppers asked for the ₹5 Dark Fantasy pack. Retailer confirmed one case at ₹600 for a front shelf placement.',
    productsDiscussed: ['Sunfeast Dark Fantasy, ₹5 pack'],
    transcript: withSegmentIds('demo-visit-007', v7),
    insights: [
      insight('demo-i-007-a', 'demand', 'demand.small-pack-five-rupees', 'Two requests for a ₹5 entry pack', 'Retailer reports two customer requests after school; the order is captured separately as one case.', 'high', 'explicit', 2, [sid('demo-visit-007', 4)], 'Two customers asked for the five-rupee Dark Fantasy pack after school yesterday.', 'Check sell-through before proposing a larger quantity.', 20500, 27900),
      insight('demo-i-007-b', 'commitment', 'commitment.confirmed-order', 'One case confirmed at ₹600', 'Retailer explicitly agrees to one case and the stated ₹600 amount.', 'high', 'explicit', 1, [sid('demo-visit-007', 6)], 'Yes, put one case on today’s order. Six hundred rupees is fine.', undefined, 41100, 47500),
      insight('demo-i-007-c', 'conversation_quality', 'quality.discovery-question', 'Rep asked what shoppers request', 'Rep opened the product discussion with a question about customer requests.', 'high', 'explicit', 1, [sid('demo-visit-007', 3)], 'What do shoppers ask for near the counter?', undefined, 11000, 17600)
    ],
    coachingSignals: [
      { rubricKey: 'discovery', label: 'Asked about shopper requests', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-007', 3), sid('demo-visit-007', 4)], note: 'The retailer gave a specific pack and customer count.' },
      { rubricKey: 'close_or_next_step', label: 'Confirmed quantity and value', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-007', 6), sid('demo-visit-007', 7)], note: 'One case and ₹600 are both explicit and retailer-confirmed.' }
    ]
  },
  {
    source: 'synthetic',
    id: 'demo-visit-008',
    createdAt: '2026-11-18T14:20:00+05:30',
    durationSeconds: 71,
    representativeId: 'rep-rohan-kulkarni',
    representativeName: 'Rohan Kulkarni',
    representativeInitials: 'RK',
    territoryId: 'territory-bengaluru-east',
    territoryName: 'Bengaluru East',
    city: 'Bengaluru',
    outletId: 'outlet-junction-daily-needs',
    outletName: 'Junction Daily Needs',
    outcome: 'follow_up',
    outcomeEvidenceSegmentIds: [sid('demo-visit-008', 4), sid('demo-visit-008', 6)],
    sentimentCue: 'at_risk',
    sentimentConfidence: 'high',
    summary: 'The ₹5 pack has been out since yesterday. Retailer wants a warehouse check and confirmation before any case is booked.',
    nextAction: 'Check warehouse availability and call before 3 pm.',
    nextActionDue: '2026-11-18T15:00:00+05:30',
    productsDiscussed: ['Sunfeast Dark Fantasy, ₹5 pack'],
    transcript: withSegmentIds('demo-visit-008', v8),
    insights: [
      insight('demo-i-008-a', 'demand', 'demand.small-pack-five-rupees', 'Requests continue during the stock-out', 'Shopkeeper reports customers asked for the ₹5 pack this morning; no quantity beyond that report is inferred.', 'medium', 'explicit', 1, [sid('demo-visit-008', 2)], 'Customers asked for it this morning', undefined, 9200, 20200),
      insight('demo-i-008-b', 'availability', 'availability.stockout-five-rupee-pack', '₹5 pack out since yesterday', 'Shopkeeper reports a stock-out that began yesterday.', 'high', 'explicit', 1, [sid('demo-visit-008', 2)], 'The five-rupee Dark Fantasy pack has been out since yesterday.', 'Confirm warehouse stock and delivery timing before promising replenishment.', 9200, 20200),
      insight('demo-i-008-c', 'sentiment', 'sentiment.stockout-frustration', 'Frustration with an empty shelf', 'Retailer directly describes the customer experience as frustrating.', 'high', 'explicit', 1, [sid('demo-visit-008', 2)], 'it is frustrating to point them to an empty shelf.', 'Close the stock check quickly and confirm the outcome to the outlet.', 9200, 20200),
      insight('demo-i-008-d', 'commitment', 'commitment.stock-confirmation-call', 'Warehouse check and callback due by 3 pm', 'Rep commits to checking the warehouse; retailer asks to hold the booking until stock is confirmed.', 'high', 'explicit', 1, [sid('demo-visit-008', 5), sid('demo-visit-008', 6)], 'I will check the warehouse and call before three this afternoon.', 'Call before 3 pm and do not book until availability is confirmed.', 48000, 68300)
    ],
    coachingSignals: [
      { rubricKey: 'discovery', label: 'Checked delivery timing', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-008', 3), sid('demo-visit-008', 4)], note: 'The rep asked about timing and got a conditional case request.' },
      { rubricKey: 'close_or_next_step', label: 'Held order until stock confirmation', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-008', 5), sid('demo-visit-008', 6)], note: 'No order is implied before availability is known.' }
    ]
  },
  {
    source: 'synthetic',
    id: 'demo-visit-009',
    createdAt: '2026-11-17T11:41:00+05:30',
    durationSeconds: 72,
    representativeId: 'rep-meera-menon',
    representativeName: 'Meera Menon',
    representativeInitials: 'MM',
    territoryId: 'territory-bengaluru-east',
    territoryName: 'Bengaluru East',
    city: 'Bengaluru',
    outletId: 'outlet-green-crossing-mart',
    outletName: 'Green Crossing Mart',
    outcome: 'follow_up',
    outcomeEvidenceSegmentIds: [sid('demo-visit-009', 6), sid('demo-visit-009', 7)],
    sentimentCue: 'hesitant',
    sentimentConfidence: 'high',
    summary: 'Retailer reports one request for a ₹5 pack, requires at least ₹0.50 margin, and asks for a 14-day credit cycle before deciding.',
    nextAction: 'Check approved margin and credit terms, then call Thursday.',
    nextActionDue: '2026-11-19T17:00:00+05:30',
    productsDiscussed: ['Sunfeast biscuit packs, ₹5 entry pack'],
    transcript: withSegmentIds('demo-visit-009', v9),
    insights: [
      insight('demo-i-009-a', 'demand', 'demand.small-pack-five-rupees', 'Request for a ₹5 entry pack', 'Retailer reports that shoppers ask for a five-rupee biscuit pack.', 'medium', 'explicit', 1, [sid('demo-visit-009', 2)], 'Some shoppers ask for a five-rupee biscuit pack.', undefined, 9300, 18100),
      insight('demo-i-009-b', 'objection', 'objection.margin-floor-fifty-paise', 'Minimum ₹0.50 margin requested', 'Retailer states a minimum per-pack margin needed for front-shelf placement.', 'high', 'explicit', 1, [sid('demo-visit-009', 2)], 'I need at least fifty paise margin to keep one in front.', 'Verify approved margin before recommending placement.', 9300, 18100),
      insight('demo-i-009-c', 'objection', 'objection.credit-cycle-fourteen-days', '14-day credit requested', 'Retailer says a fourteen-day cycle would help but has not agreed to an order.', 'high', 'explicit', 1, [sid('demo-visit-009', 4)], 'Fourteen days would help, but I need to see the written margin before I decide.', 'Route the request through the approved credit process.', 33300, 41400),
      insight('demo-i-009-d', 'sentiment', 'sentiment.waiting-for-margin-approval', 'Decision pending written margin', 'Retailer explicitly withholds a decision until the margin is documented.', 'high', 'explicit', 1, [sid('demo-visit-009', 4)], 'I need to see the written margin before I decide.', undefined, 33300, 41400),
      insight('demo-i-009-e', 'commitment', 'commitment.manager-margin-check', 'Rep will confirm terms Thursday', 'Rep commits to check approved margin and call Thursday; no order is placed.', 'high', 'explicit', 1, [sid('demo-visit-009', 5), sid('demo-visit-009', 7)], 'I will confirm the approved margin and call Thursday. No order today.', 'Return with an approved answer before discussing an order.', 45200, 70600)
    ],
    coachingSignals: [
      { rubricKey: 'objection_response', label: 'Respected the margin approval boundary', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-009', 5), sid('demo-visit-009', 7)], note: 'Rep offered to check rather than promise unapproved terms.' },
      { rubricKey: 'close_or_next_step', label: 'Set a dated follow-up without recording an order', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-009', 6), sid('demo-visit-009', 7)], note: 'Retailer requested a Thursday callback; outcome remains follow-up.' }
    ]
  },
  {
    source: 'synthetic',
    id: 'demo-visit-010',
    createdAt: '2026-11-18T09:30:00+05:30',
    durationSeconds: 70,
    representativeId: 'rep-aman-verma',
    representativeName: 'Aman Verma',
    representativeInitials: 'AV',
    territoryId: 'territory-bengaluru-east',
    territoryName: 'Bengaluru East',
    city: 'Bengaluru',
    outletId: 'outlet-lake-road-provisions',
    outletName: 'Lake Road Provisions',
    outcome: 'follow_up',
    outcomeEvidenceSegmentIds: [sid('demo-visit-010', 6), sid('demo-visit-010', 7)],
    sentimentCue: 'neutral',
    sentimentConfidence: 'medium',
    summary: 'Retailer reports an observed shelf-price and pack-weight comparison with a competitor. Rep will bring a current price and weight sheet; no order change was agreed.',
    nextAction: 'Bring the current price and pack-weight sheet on Tuesday.',
    nextActionDue: '2026-11-24T12:00:00+05:30',
    productsDiscussed: ['Sunfeast snack pack', 'Unnamed competing 20 g snack pack'],
    transcript: withSegmentIds('demo-visit-010', v10),
    insights: [
      insight('demo-i-010-a', 'demand', 'demand.small-pack-five-rupees', 'Question about a ₹5 pack with more grams', 'One shopper asked about a five-rupee pack with greater pack weight.', 'medium', 'explicit', 1, [sid('demo-visit-010', 2)], 'One shopper asked for a five-rupee pack with more grams.', undefined, 9300, 20500),
      insight('demo-i-010-b', 'competitor', 'competitor.price-weight-comparison', 'Reported price and weight comparison', 'Retailer reports checking shelf tags: the competing pack is marked ₹5 at 20 g and the discussed pack is 18 g at the same price. This is a retailer report, not an independently verified market audit.', 'medium', 'explicit', 1, [sid('demo-visit-010', 2), sid('demo-visit-010', 4)], 'The other brand’s twenty-gram pack is marked five rupees. This one is eighteen grams at the same price.', 'Verify both current pack labels and compare like for like.', 9300, 20500),
      insight('demo-i-010-c', 'sentiment', 'sentiment.price-comparison-requested', 'Retailer wants comparison before changing the order', 'Retailer explicitly asks to compare current details before making a decision.', 'medium', 'explicit', 1, [sid('demo-visit-010', 6)], 'Let us compare on Tuesday. Do not change the order today.', undefined, 54600, 61200),
      insight('demo-i-010-d', 'commitment', 'commitment.current-price-weight-sheet', 'Rep will bring a current price and weight sheet', 'The rep agrees to bring product details for a like-for-like comparison on Tuesday.', 'high', 'explicit', 1, [sid('demo-visit-010', 5), sid('demo-visit-010', 7)], 'I will bring the current price and weight sheet.', 'Review current shelf labels and pack weights on Tuesday.', 44400, 69100)
    ],
    coachingSignals: [
      { rubricKey: 'discovery', label: 'Checked how the comparison was sourced', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-010', 3), sid('demo-visit-010', 4)], note: 'Rep asked whether the retailer had checked the tags.' },
      { rubricKey: 'close_or_next_step', label: 'Agreed to verify before changing the order', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-010', 5), sid('demo-visit-010', 6), sid('demo-visit-010', 7)], note: 'Follow-up is a price/weight check; no order change is implied.' }
    ]
  },
  {
    source: 'synthetic',
    id: 'demo-visit-011',
    createdAt: '2026-11-16T15:15:00+05:30',
    durationSeconds: 72,
    representativeId: 'rep-devika-shetty',
    representativeName: 'Devika Shetty',
    representativeInitials: 'DS',
    territoryId: 'territory-mysuru-north',
    territoryName: 'Mysuru North',
    city: 'Mysuru',
    outletId: 'outlet-market-square-stores',
    outletName: 'Market Square Stores',
    outcome: 'follow_up',
    outcomeEvidenceSegmentIds: [sid('demo-visit-011', 5), sid('demo-visit-011', 6)],
    sentimentCue: 'hesitant',
    sentimentConfidence: 'medium',
    summary: 'Two customers asked for five-rupee biscuit packs while the shelf was out of stock. Retailer would consider a case if stock and the usual seven-day credit are confirmed.',
    nextAction: 'Confirm stock and seven-day credit terms, then call by 5 pm.',
    nextActionDue: '2026-11-16T17:00:00+05:30',
    productsDiscussed: ['Sunfeast biscuit packs, ₹5 entry pack'],
    transcript: withSegmentIds('demo-visit-011', v11),
    insights: [
      insight('demo-i-011-a', 'demand', 'demand.small-pack-five-rupees', 'Two requests during the breakfast rush', 'Shopkeeper reports two customer requests for five-rupee biscuit packs.', 'high', 'explicit', 2, [sid('demo-visit-011', 2)], 'Two customers asked for five-rupee biscuit packs during breakfast.', undefined, 9000, 18200),
      insight('demo-i-011-b', 'availability', 'availability.stockout-five-rupee-pack', 'Five-rupee packs out since yesterday', 'Retailer reports being out of stock since the previous day.', 'high', 'explicit', 1, [sid('demo-visit-011', 2)], 'We have been out since yesterday.', 'Confirm replenishment timing before accepting the conditional case.', 9000, 18200),
      insight('demo-i-011-c', 'objection', 'objection.credit-cycle-seven-days', 'Seven-day credit required', 'Shopkeeper says the usual seven-day credit is needed for a possible case; order remains conditional on arrival time.', 'high', 'explicit', 1, [sid('demo-visit-011', 4)], 'I need the usual seven-day credit.', 'Confirm that the existing terms apply; do not extend credit without approval.', 32300, 41400),
      insight('demo-i-011-d', 'sentiment', 'sentiment.conditional-on-delivery', 'Retailer is unsure until delivery is confirmed', 'The retailer responds with a conditional quantity and timing requirement.', 'medium', 'uncertain', 1, [sid('demo-visit-011', 4)], 'Maybe one case, if it arrives before eight.', undefined, 32300, 41400),
      insight('demo-i-011-e', 'commitment', 'commitment.stock-and-terms-callback', 'Rep will confirm availability by 5 pm', 'Rep will check stock and terms; retailer asks not to write the order before confirmation.', 'high', 'explicit', 1, [sid('demo-visit-011', 5), sid('demo-visit-011', 6), sid('demo-visit-011', 7)], 'I will check stock and terms with distribution and call by five.', 'Call by 5 pm before booking any stock.', 45000, 71000)
    ],
    coachingSignals: [
      { rubricKey: 'objection_response', label: 'Kept the case conditional on delivery and terms', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-011', 3), sid('demo-visit-011', 4)], note: 'Rep did not treat a tentative response as a confirmed order.' },
      { rubricKey: 'close_or_next_step', label: 'Set a timed confirmation call', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-011', 5), sid('demo-visit-011', 7)], note: 'Availability follow-up has a clear deadline.' }
    ]
  },
  {
    source: 'synthetic',
    id: 'demo-visit-012',
    createdAt: '2026-11-14T12:10:00+05:30',
    durationSeconds: 72,
    representativeId: 'rep-kiran-bhat',
    representativeName: 'Kiran Bhat',
    representativeInitials: 'KB',
    territoryId: 'territory-mysuru-north',
    territoryName: 'Mysuru North',
    city: 'Mysuru',
    outletId: 'outlet-peepal-tree-kirana',
    outletName: 'Peepal Tree Kirana',
    outcome: 'no_order',
    outcomeEvidenceSegmentIds: [sid('demo-visit-012', 6), sid('demo-visit-012', 7)],
    sentimentCue: 'hesitant',
    sentimentConfidence: 'high',
    summary: 'Retailer reports one ₹5 pack request and states minimum margin and credit requirements. A competitor price change is hearsay; retailer decides after reviewing documents, with no order today.',
    nextAction: 'Bring approved margin and current price documents on Monday.',
    nextActionDue: '2026-11-16T12:00:00+05:30',
    productsDiscussed: ['Sunfeast biscuit packs, ₹5 entry pack', 'Unverified competing ₹10 pack'],
    transcript: withSegmentIds('demo-visit-012', v12),
    insights: [
      insight('demo-i-012-a', 'demand', 'demand.small-pack-five-rupees', 'Request for a ₹5 pack', 'Retailer reports one customer request at the counter; no order is inferred.', 'medium', 'explicit', 1, [sid('demo-visit-012', 2)], 'One customer asked for a five-rupee pack at the counter.', undefined, 9400, 17300),
      insight('demo-i-012-b', 'objection', 'objection.margin-floor-forty-paise', 'Minimum ₹0.40 margin requested', 'Retailer states a minimum per-pack margin requirement.', 'high', 'explicit', 1, [sid('demo-visit-012', 2)], 'I need at least forty paise margin', 'Check the approved margin before proposing a placement.', 9400, 17300),
      insight('demo-i-012-c', 'objection', 'objection.credit-cycle-fifteen-days', '15-day credit requested', 'Retailer names a fifteen-day credit requirement; no approval is implied.', 'high', 'explicit', 1, [sid('demo-visit-012', 2)], 'fifteen days credit.', 'Route the credit request through the approved process.', 9400, 17300),
      insight('demo-i-012-d', 'competitor', 'competitor.future-price-change-hearsay', 'Possible future competitor price change', 'Retailer has heard that a competing pack price may change next month but has not seen a current price list.', 'low', 'uncertain', 1, [sid('demo-visit-012', 4)], 'I heard the competing ten-rupee pack price may change next month, but I have not seen the new list.', 'Verify the current competitor price and any change date before comparison.', 31600, 40300),
      insight('demo-i-012-e', 'sentiment', 'sentiment.decision-pending-information', 'Decision pending written information', 'Retailer states that the decision will follow review of the documents and explicitly places no order today.', 'high', 'explicit', 1, [sid('demo-visit-012', 6)], 'Then I can decide. There is no order today.', undefined, 55100, 61500),
      insight('demo-i-012-f', 'commitment', 'commitment.margin-price-documents', 'Rep will return with margin and price documents', 'Rep agrees to bring both requested documents Monday.', 'high', 'explicit', 1, [sid('demo-visit-012', 5), sid('demo-visit-012', 7)], 'I will bring the approved margin sheet and current price list Monday.', 'Bring approved materials; re-open the order discussion only after review.', 44200, 70600)
    ],
    coachingSignals: [
      { rubricKey: 'objection_response', label: 'Separated unverified competitor information from facts', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-012', 3), sid('demo-visit-012', 4)], note: 'Rep will bring a current list rather than repeat the hearsay as fact.' },
      { rubricKey: 'close_or_next_step', label: 'Recorded no order and a document review', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-012', 5), sid('demo-visit-012', 6), sid('demo-visit-012', 7)], note: 'The retailer has not committed to a purchase.' }
    ]
  },
  {
    source: 'synthetic',
    id: 'demo-visit-013',
    createdAt: '2026-11-18T10:54:00+05:30',
    durationSeconds: 72,
    representativeId: 'rep-devika-shetty',
    representativeName: 'Devika Shetty',
    representativeInitials: 'DS',
    territoryId: 'territory-mysuru-north',
    territoryName: 'Mysuru North',
    city: 'Mysuru',
    outletId: 'outlet-river-street-mini-mart',
    outletName: 'River Street Mini Mart',
    outcome: 'no_order',
    outcomeEvidenceSegmentIds: [sid('demo-visit-013', 6), sid('demo-visit-013', 7)],
    sentimentCue: 'hesitant',
    sentimentConfidence: 'medium',
    summary: 'Retailer reports evening interest in a ₹5 pack. A rival seller’s reported ₹10 price is unverified; retailer requests details before considering stock.',
    nextAction: 'Send the current price and pack-size details before Friday.',
    nextActionDue: '2026-11-20T12:00:00+05:30',
    productsDiscussed: ['Sunfeast Dark Fantasy, ₹5 pack', 'Unverified competing blue pack'],
    transcript: withSegmentIds('demo-visit-013', v13),
    insights: [
      insight('demo-i-013-a', 'demand', 'demand.small-pack-five-rupees', 'Evening requests for a ₹5 entry pack', 'Retailer reports regulars ask for the pack; no count of individual shoppers is inferred.', 'medium', 'explicit', 1, [sid('demo-visit-013', 2)], 'Some regulars ask us for the five-rupee Dark Fantasy pack in the evening.', undefined, 9100, 18400),
      insight('demo-i-013-b', 'competitor', 'competitor.unnamed-blue-pack', 'Unverified ₹10 competitor price', 'Price is reported second-hand, with no verified shelf tag, brand, or pack size.', 'low', 'uncertain', 1, [sid('demo-visit-013', 4)], 'A rival seller told me ten rupees, but I have not seen the price tag or pack size.', 'Verify brand, pack size, and shelf price before comparison.', 32100, 42000),
      insight('demo-i-013-c', 'sentiment', 'sentiment.cautious-before-order', 'Retailer wants details before deciding', 'Retailer asks to review the details before any booking.', 'medium', 'explicit', 1, [sid('demo-visit-013', 6)], 'Please send me the details first. Do not book any stock yet.', undefined, 56300, 63200),
      insight('demo-i-013-d', 'commitment', 'commitment.send-price-details', 'Rep will send details Friday', 'Rep agrees to send current price details; the retailer explicitly says no order has been placed.', 'high', 'explicit', 1, [sid('demo-visit-013', 5), sid('demo-visit-013', 7)], 'I will send the details Friday. No order has been placed.', 'Send verified product details before Friday and wait for retailer confirmation.', 45700, 71800)
    ],
    coachingSignals: [
      { rubricKey: 'discovery', label: 'Asked about current customer requests', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-013', 1), sid('demo-visit-013', 2)], note: 'The answer identifies pack type and occasion, but not a numeric customer count.' },
      { rubricKey: 'objection_response', label: 'Did not treat a second-hand price as verified', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-013', 3), sid('demo-visit-013', 4), sid('demo-visit-013', 5)], note: 'The next step is to bring current price details.' },
      { rubricKey: 'close_or_next_step', label: 'Waited for retailer confirmation', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-013', 6), sid('demo-visit-013', 7)], note: 'No stock was booked during this visit.' }
    ]
  },
  {
    source: 'synthetic',
    id: 'demo-visit-014',
    createdAt: '2026-11-12T16:02:00+05:30',
    durationSeconds: 73,
    representativeId: 'rep-kiran-bhat',
    representativeName: 'Kiran Bhat',
    representativeInitials: 'KB',
    territoryId: 'territory-hubballi-central',
    territoryName: 'Hubballi Central',
    city: 'Hubballi',
    outletId: 'outlet-school-road-provisions',
    outletName: 'School Road Provisions',
    outcome: 'follow_up',
    outcomeEvidenceSegmentIds: [sid('demo-visit-014', 5), sid('demo-visit-014', 6), sid('demo-visit-014', 7)],
    sentimentCue: 'at_risk',
    sentimentConfidence: 'high',
    summary: 'One parent asked for a ₹5 pack while the shelf was out since Monday. Retailer reports disappointment and will consider a case if Saturday stock is confirmed.',
    nextAction: 'Check the next van and call tomorrow with the stock status.',
    nextActionDue: '2026-11-13T12:00:00+05:30',
    productsDiscussed: ['Sunfeast Dark Fantasy, ₹5 pack'],
    transcript: withSegmentIds('demo-visit-014', v14),
    insights: [
      insight('demo-i-014-a', 'demand', 'demand.small-pack-five-rupees', 'One request for a ₹5 school snack pack', 'One parent request is reported; the conditional case is not counted as an order.', 'medium', 'explicit', 1, [sid('demo-visit-014', 2)], 'One parent asked for the five-rupee Dark Fantasy pack for a school snack.', undefined, 9400, 18800),
      insight('demo-i-014-b', 'availability', 'availability.stockout-five-rupee-pack', 'Pack out since Monday', 'Shopkeeper reports the pack has been unavailable since Monday.', 'high', 'explicit', 1, [sid('demo-visit-014', 2)], 'We have been out since Monday.', 'Confirm delivery timing before accepting the conditional case.', 9400, 18800),
      insight('demo-i-014-c', 'sentiment', 'sentiment.stockout-disappointment', 'Disappointment with prolonged stock-out', 'Retailer directly describes the empty shelf experience as disappointing.', 'high', 'explicit', 1, [sid('demo-visit-014', 4)], 'The empty shelf has been disappointing.', 'Close the availability loop with a clear callback.', 33000, 40500),
      insight('demo-i-014-d', 'commitment', 'commitment.stock-confirmation-call', 'Rep will confirm availability tomorrow', 'Rep will check the next van and call; retailer’s case remains conditional on Saturday stock.', 'high', 'explicit', 1, [sid('demo-visit-014', 5), sid('demo-visit-014', 6), sid('demo-visit-014', 7)], 'I will check the van and call tomorrow with the stock status.', 'Call tomorrow; book only if Saturday stock is confirmed.', 44300, 72000)
    ],
    coachingSignals: [
      { rubricKey: 'discovery', label: 'Checked the delivery option', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-014', 3), sid('demo-visit-014', 4)], note: 'The rep asked about the next van and got a target date.' },
      { rubricKey: 'close_or_next_step', label: 'Kept the case conditional on stock', confidence: 'high', evidenceSegmentIds: [sid('demo-visit-014', 5), sid('demo-visit-014', 6), sid('demo-visit-014', 7)], note: 'The callback is explicit and no order has been booked.' }
    ]
  }
];

export interface DemoSignalAggregate {
  taxonomyKey: string;
  category: InsightCategory;
  title: string;
  distinctVisitCount: number;
  distinctOutletCount: number;
  /** Raw supported occurrences; a visit or outlet can contribute more than one. */
  rawMentionCount: number;
  /** Counts of supporting insight records by confidence, not counts of raw mentions. */
  confidenceCounts: Record<Confidence, number>;
  territories: string[];
  territoryBreakdown: Array<{
    territoryId: string;
    territoryName: string;
    distinctVisitCount: number;
    distinctOutletCount: number;
    rawMentionCount: number;
  }>;
  representativeBreakdown: Array<{
    representativeId: string;
    representativeName: string;
    distinctVisitCount: number;
    distinctOutletCount: number;
    rawMentionCount: number;
  }>;
  examples: Array<{
    visitId: string;
    outletName: string;
    representativeName: string;
    confidence: Confidence;
    quote: string;
    segmentIds: string[];
  }>;
}

/**
 * Aggregate supported signals by normalized taxonomy key.
 * A visit is counted once per key even when the same signal was mentioned repeatedly.
 */
export function aggregateDemoSignals(conversations: DemoConversation[] = demoConversations): DemoSignalAggregate[] {
  interface DimensionTally {
    distinctVisitIds: Set<string>;
    distinctOutletIds: Set<string>;
    rawMentionCount: number;
  }

  type MutableSignalAggregate = DemoSignalAggregate & {
    visitIds: Set<string>;
    outletIds: Set<string>;
    territoryNames: Set<string>;
    territoryTallies: Map<string, DimensionTally>;
    representativeTallies: Map<string, DimensionTally>;
  };

  const aggregates = new Map<string, MutableSignalAggregate>();

  for (const conversation of conversations) {
    for (const item of conversation.insights) {
      const key = item.taxonomyKey;
      let aggregate = aggregates.get(key);

      if (!aggregate) {
        aggregate = {
          taxonomyKey: key,
          category: item.category,
          title: item.title,
          distinctVisitCount: 0,
          distinctOutletCount: 0,
          rawMentionCount: 0,
          confidenceCounts: { high: 0, medium: 0, low: 0 },
          territories: [],
          territoryBreakdown: [],
          representativeBreakdown: [],
          examples: [],
          visitIds: new Set<string>(),
          outletIds: new Set<string>(),
          territoryNames: new Set<string>(),
          territoryTallies: new Map<string, DimensionTally>(),
          representativeTallies: new Map<string, DimensionTally>()
        };
        aggregates.set(key, aggregate);
      }

      aggregate.rawMentionCount += item.mentionCount;
      aggregate.visitIds.add(conversation.id);
      aggregate.outletIds.add(conversation.outletId);
      aggregate.territoryNames.add(conversation.territoryName);
      aggregate.confidenceCounts[item.confidence] += 1;

      const territory = aggregate.territoryTallies.get(conversation.territoryId) ?? {
        distinctVisitIds: new Set<string>(),
        distinctOutletIds: new Set<string>(),
        rawMentionCount: 0
      };
      territory.distinctVisitIds.add(conversation.id);
      territory.distinctOutletIds.add(conversation.outletId);
      territory.rawMentionCount += item.mentionCount;
      aggregate.territoryTallies.set(conversation.territoryId, territory);

      const representative = aggregate.representativeTallies.get(conversation.representativeId) ?? {
        distinctVisitIds: new Set<string>(),
        distinctOutletIds: new Set<string>(),
        rawMentionCount: 0
      };
      representative.distinctVisitIds.add(conversation.id);
      representative.distinctOutletIds.add(conversation.outletId);
      representative.rawMentionCount += item.mentionCount;
      aggregate.representativeTallies.set(conversation.representativeId, representative);

      for (const itemEvidence of item.evidence) {
        aggregate.examples.push({
          visitId: conversation.id,
          outletName: conversation.outletName,
          representativeName: conversation.representativeName,
          confidence: item.confidence,
          quote: itemEvidence.quote,
          segmentIds: itemEvidence.segmentIds
        });
      }
    }
  }

  return [...aggregates.values()]
    .map(({ visitIds, outletIds, territoryNames, territoryTallies, representativeTallies, ...aggregate }) => ({
      ...aggregate,
      distinctVisitCount: visitIds.size,
      distinctOutletCount: outletIds.size,
      territories: [...territoryNames].sort(),
      territoryBreakdown: [...territoryTallies.entries()]
        .map(([territoryId, tally]) => ({
          territoryId,
          territoryName: conversations.find((conversation) => conversation.territoryId === territoryId)?.territoryName ?? territoryId,
          distinctVisitCount: tally.distinctVisitIds.size,
          distinctOutletCount: tally.distinctOutletIds.size,
          rawMentionCount: tally.rawMentionCount
        }))
        .sort((a, b) => b.rawMentionCount - a.rawMentionCount || a.territoryName.localeCompare(b.territoryName)),
      representativeBreakdown: [...representativeTallies.entries()]
        .map(([representativeId, tally]) => ({
          representativeId,
          representativeName: conversations.find((conversation) => conversation.representativeId === representativeId)?.representativeName ?? representativeId,
          distinctVisitCount: tally.distinctVisitIds.size,
          distinctOutletCount: tally.distinctOutletIds.size,
          rawMentionCount: tally.rawMentionCount
        }))
        .sort((a, b) => b.rawMentionCount - a.rawMentionCount || a.representativeName.localeCompare(b.representativeName))
    }))
    .sort((a, b) => b.distinctVisitCount - a.distinctVisitCount || b.rawMentionCount - a.rawMentionCount || a.title.localeCompare(b.title));
}

export interface DemoDailyAggregate {
  date: string;
  visitCount: number;
  distinctOutletCount: number;
  orderCount: number;
  followUpCount: number;
  noOrderCount: number;
  newOutletCount: number;
  confirmedOrderValueInr: number;
  /** Totals supported insight occurrences across categories; overlapping findings can count the same passage more than once. */
  rawInsightMentionCount: number;
  categoryMentionCounts: Record<InsightCategory, number>;
}

/** Daily time-series data for report charts. Visit/outlet counts are distinct within each day. */
export function aggregateDemoDaily(conversations: DemoConversation[] = demoConversations): DemoDailyAggregate[] {
  const byDate = new Map<string, DemoDailyAggregate & { outletIds: Set<string> }>();

  for (const conversation of conversations) {
    const date = conversation.createdAt.slice(0, 10);
    let daily = byDate.get(date);
    if (!daily) {
      daily = {
        date,
        visitCount: 0,
        distinctOutletCount: 0,
        orderCount: 0,
        followUpCount: 0,
        noOrderCount: 0,
        newOutletCount: 0,
        confirmedOrderValueInr: 0,
        rawInsightMentionCount: 0,
        categoryMentionCounts: {
          demand: 0,
          objection: 0,
          availability: 0,
          competitor: 0,
          sentiment: 0,
          commitment: 0,
          conversation_quality: 0
        },
        outletIds: new Set<string>()
      };
      byDate.set(date, daily);
    }

    daily.visitCount += 1;
    daily.outletIds.add(conversation.outletId);
    daily.confirmedOrderValueInr += conversation.confirmedOrderValueInr ?? 0;
    if (conversation.outcome === 'order_placed') daily.orderCount += 1;
    if (conversation.outcome === 'follow_up') daily.followUpCount += 1;
    if (conversation.outcome === 'no_order') daily.noOrderCount += 1;
    if (conversation.outcome === 'new_outlet') daily.newOutletCount += 1;

    for (const item of conversation.insights) {
      daily.rawInsightMentionCount += item.mentionCount;
      daily.categoryMentionCounts[item.category] += item.mentionCount;
    }
  }

  return [...byDate.values()]
    .map(({ outletIds, ...daily }) => ({ ...daily, distinctOutletCount: outletIds.size }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface DemoCoachingAggregate {
  rubricKey: DemoCoachingSignal['rubricKey'];
  distinctVisitCount: number;
  distinctOutletCount: number;
  distinctRepresentativeCount: number;
  signalCount: number;
  confidenceCounts: Record<Confidence, number>;
  examples: Array<{
    visitId: string;
    outletName: string;
    territoryName: string;
    representativeName: string;
    label: string;
    confidence: Confidence;
    evidenceSegmentIds: string[];
    note: string;
  }>;
}

/** Coaching observations aggregate separately from extracted sales findings. */
export function aggregateDemoCoaching(conversations: DemoConversation[] = demoConversations): DemoCoachingAggregate[] {
  type MutableCoachingAggregate = DemoCoachingAggregate & {
    visitIds: Set<string>;
    outletIds: Set<string>;
    representativeIds: Set<string>;
  };
  const aggregates = new Map<DemoCoachingSignal['rubricKey'], MutableCoachingAggregate>();

  for (const conversation of conversations) {
    for (const signal of conversation.coachingSignals) {
      let aggregate = aggregates.get(signal.rubricKey);
      if (!aggregate) {
        aggregate = {
          rubricKey: signal.rubricKey,
          distinctVisitCount: 0,
          distinctOutletCount: 0,
          distinctRepresentativeCount: 0,
          signalCount: 0,
          confidenceCounts: { high: 0, medium: 0, low: 0 },
          examples: [],
          visitIds: new Set<string>(),
          outletIds: new Set<string>(),
          representativeIds: new Set<string>()
        };
        aggregates.set(signal.rubricKey, aggregate);
      }

      aggregate.signalCount += 1;
      aggregate.visitIds.add(conversation.id);
      aggregate.outletIds.add(conversation.outletId);
      aggregate.representativeIds.add(conversation.representativeId);
      aggregate.confidenceCounts[signal.confidence] += 1;
      aggregate.examples.push({
        visitId: conversation.id,
        outletName: conversation.outletName,
        territoryName: conversation.territoryName,
        representativeName: conversation.representativeName,
        label: signal.label,
        confidence: signal.confidence,
        evidenceSegmentIds: signal.evidenceSegmentIds,
        note: signal.note
      });
    }
  }

  return [...aggregates.values()]
    .map(({ visitIds, outletIds, representativeIds, ...aggregate }) => ({
      ...aggregate,
      distinctVisitCount: visitIds.size,
      distinctOutletCount: outletIds.size,
      distinctRepresentativeCount: representativeIds.size
    }))
    .sort((a, b) => b.distinctVisitCount - a.distinctVisitCount || a.rubricKey.localeCompare(b.rubricKey));
}

export const demoReportSummary = {
  source: demoDataMode,
  notice: demoDataNotice,
  analyzedVisitCount: demoConversations.length,
  uniqueOutletCount: new Set(demoConversations.map((conversation) => conversation.outletId)).size,
  territoryCount: new Set(demoConversations.map((conversation) => conversation.territoryId)).size,
  confirmedOrderCount: demoConversations.filter((conversation) => conversation.outcome === 'order_placed').length,
  valuedOrderCount: demoConversations.filter((conversation) => conversation.outcome === 'order_placed' && conversation.confirmedOrderValueInr !== undefined).length,
  unvaluedOrderCount: demoConversations.filter((conversation) => conversation.outcome === 'order_placed' && conversation.confirmedOrderValueInr === undefined).length,
  followUpCount: demoConversations.filter((conversation) => conversation.outcome === 'follow_up').length,
  noOrderCount: demoConversations.filter((conversation) => conversation.outcome === 'no_order').length,
  newOutletCount: demoConversations.filter((conversation) => conversation.outcome === 'new_outlet').length,
  confirmedOrderValueInr: demoConversations.reduce((total, conversation) => total + (conversation.confirmedOrderValueInr ?? 0), 0),
  insightCount: demoConversations.reduce((total, conversation) => total + conversation.insights.length, 0),
  rawInsightMentionCount: demoConversations.reduce((total, conversation) => total + conversation.insights.reduce((visitTotal, item) => visitTotal + item.mentionCount, 0), 0),
  note: 'Only explicitly stated order values are included; conditional trial interest is not valued.'
} as const;

export const demoSignalAggregates = aggregateDemoSignals();
export const demoDailyAggregates = aggregateDemoDaily();
export const demoCoachingAggregates = aggregateDemoCoaching();

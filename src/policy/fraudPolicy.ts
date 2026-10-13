export interface FraudAssessment { suspected: boolean; immediate: boolean; }
export function assessFraud(message: string, reportedAmount?: number): FraudAssessment {
  const report = /unauthori[sz]ed|never (?:made|authorized)|didn['’]t authori[sz]e|did not authori[sz]e|used my card without permission|card was stolen|card stolen|taken over my account|account takeover|don['’]t recognize (?:this )?(?:payment|transaction|charge)/i;
  const generalQuestion = /\b(?:how|what)\b[^?.!]{0,60}\bfraud\b|\bprevent fraud\b/i;
  const suspected = report.test(message) && !generalQuestion.test(message);
  return { suspected, immediate: suspected && (reportedAmount ?? 0) > 500 };
}

export interface FraudAssessment { suspected: boolean; immediate: boolean; }
export function assessFraud(message: string, reportedAmount?: number): FraudAssessment {
  const suspected = /unauthori[sz]ed|did not (make|authori[sz]e)|stolen|account takeover|fraud/i.test(message);
  return { suspected, immediate: suspected && (reportedAmount ?? 0) > 500 };
}

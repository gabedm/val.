export type UrnValChallenger06 = {
  version: 1 | 2;
  purpose: string;
  /**
   * @maxItems 2
   */
  requiredCapabilities:
    | []
    | ["editable_text" | "speaker_labels"]
    | ["editable_text" | "speaker_labels", "editable_text" | "speaker_labels"];
  replacementCeilingMinor: number;
  preserveHistory: true;
  /**
   * @maxItems 4
   */
  unsupportedRequirements:
    [] | [string] | [string, string] | [string, string, string] | [string, string, string, string];
  notice: string;
  valueCase?: {
    scenario: "value_offer";
  };
  plans: {
    a_01: PlanBehavior;
    a_02: PlanBehavior;
    b_01: PlanBehavior;
    b_02: PlanBehavior;
    b_03?: PlanBehavior;
  };
};

export interface PlanBehavior {
  marketingText: string;
  editableText: boolean;
  speakerLabels: boolean;
}

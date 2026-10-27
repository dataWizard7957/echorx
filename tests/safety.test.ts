import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRedFlagRules } from "../server/agents/safetySentinel.ts";

const fires = [
  ["en", "I have chest pain since this morning"],
  ["en", "my chest pain does not go away"],
  ["en", "I can't breathe well"],
  ["en", "I passed out yesterday"],
  ["en", "sometimes I think about ending it, I want to kill myself"],
  ["bn", "আমার বুকে ব্যথা করছে"],
  ["bn", "শ্বাসকষ্ট হচ্ছে"],
  ["ar", "عندي ألم في الصدر"],
  ["ar", "أغمي علي أمس"],
  ["es", "Tengo dolor en el pecho"],
  ["es", "No puedo respirar bien"],
  ["es", "me desmayé en la cocina"],
];
const quiet = [
  ["en", "no chest pain"],
  ["en", "I don't have chest pain, just a headache"],
  ["en", "I feel dizzy sometimes when I stand up"],
  ["bn", "বুকে ব্যথা নেই"],
  ["bn", "মাঝে মাঝে মাথা ঘোরে"],
  ["ar", "لا يوجد ألم في الصدر"],
  ["es", "no tengo dolor en el pecho"],
  ["es", "a veces me mareo"],
];

for (const [lang, text] of fires) test(`red flag fires (${lang}): ${text}`, () => assert.equal(checkRedFlagRules(text).redFlag, true));
for (const [lang, text] of quiet) test(`no red flag (${lang}): ${text}`, () => assert.equal(checkRedFlagRules(text).redFlag, false));
test("a negated clause does not hide a real red flag in another clause", () => {
  assert.equal(checkRedFlagRules("No fever, but I have chest pain").redFlag, true);
});

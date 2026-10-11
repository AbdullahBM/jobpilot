// verify-loop.mjs — prove the human-in-the-loop: unknown Q -> pending -> learn once -> reused.
import { initDB, getDB, save } from '../src/tracker.js';
import { textAnswer } from '../src/mcp/answers.js';
import { askLater, pendingQuestions, learn, learnedAnswer } from '../src/evolve.js';
await initDB();
const Q = 'What is your preferred four-day-week arrangement for the __looptest__ role?';
// clean any prior test rows
getDB().run("DELETE FROM answers WHERE question LIKE '%__looptest__%'"); save();

// 1) Agent cannot answer it from the profile → null
const first = textAnswer(Q);
console.log('1. agent tries from profile  ->', JSON.stringify(first), first === null ? '(unknown, as expected)' : '');

// 2) It parks the question for the user (what the apply flow does)
askLater(Q);
const pend = pendingQuestions().some(p => p.question === Q);
console.log('2. parked for user?          ->', pend, '(shows in dashboard Questions tab)');

// 3) User answers once (what /api/answers POST does)
learn(Q, 'Mon–Thu, Fridays off', 'user');
console.log('3. user answered once        -> stored');

// 4) Reused automatically on the next application, and no longer pending
const reused = textAnswer(Q);
const stillPending = pendingQuestions().some(p => p.question === Q);
console.log('4. reused next time          ->', JSON.stringify(reused));
console.log('   still asking?             ->', stillPending, '(false = remembered forever)');

// 5) Fuzzy match: a reworded version of the same question also resolves
const reworded = 'preferred four-day-week arrangement for the __looptest__ position';
console.log('5. fuzzy match on reword     ->', JSON.stringify(learnedAnswer(reworded)));

getDB().run("DELETE FROM answers WHERE question LIKE '%__looptest__%'"); save();
console.log('\\nPASS:', first === null && pend && reused === 'Mon–Thu, Fridays off' && !stillPending);
process.exit(0);

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');

const { jwt: { AccessToken } } = twilio;
const VoiceGrant = AccessToken.VoiceGrant;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

// ------------------- Orders: numeric-only IDs -------------------
const RAW_ORDERS = {
  "123": { id: "123", product: "Wireless Headphones", price: 2999, delivery: "2025-10-01" },
  "789": { id: "789", product: "Bluetooth Speaker",   price: 1499, delivery: "2025-09-25" }
};
const ORDERS = { ...RAW_ORDERS };

// ------------------- Session Store (per CallSid) -------------------
const SESSIONS = new Map();
// stages: verify_order -> after_delivery -> retention_offer -> human_offer -> return_confirm -> done
const OFFERS = [
  { code: 'BOGO',     text: 'Buy One Get One' },
  { code: 'FREE_ACC', text: 'a free accessory' },
  { code: '50_OFF',   text: '50% discount' },
];

// ------------------- Utils -------------------
function wordsToDigits(s) {
  const map = {
    'ZERO': '0', 'OH': '0', 'O': '0',
    'ONE': '1', 'TWO': '2', 'TO': '2', 'TOO': '2',
    'THREE': '3', 'FOUR': '4', 'FOR': '4',
    'FIVE': '5', 'SIX': '6',
    'SEVEN': '7', 'EIGHT': '8', 'ATE': '8',
    'NINE': '9'
  };
  return s.replace(/\b(oh|o|zero|one|two|too|to|three|four|for|five|six|seven|eight|ate|nine)\b/gi, (m) => map[m.toUpperCase()] || m);
}
function collapseSpacedDigits(s) {
  return s.replace(/\d(?:\s+\d)+/g, (seq) => seq.replace(/\s+/g, ''));
}
function extractNumericOrderId(textRaw) {
  if (!textRaw) return null;
  let t = textRaw.toUpperCase().trim();

  // Convert spelled-out numbers to digits: "one two three" -> "1 2 3"
  t = wordsToDigits(t);

  // Replace anything that's not a digit with spaces: "1, 2 3." -> "1  2 3 "
  t = t.replace(/[^\d]+/g, ' ').trim();

  // Collapse spaced digits: "1 2 3" -> "123"
  t = collapseSpacedDigits(t);

  // Find digit runs (>=2). Prefer 3+ digits if present.
  const matches = t.match(/\d{2,}/g);
  if (!matches) return null;
  const candidate = matches.find(x => x.length >= 3) || matches[0];
  return candidate;
}
function sayAndGather(twiml, text, action, hints = '') {
  const g = twiml.gather({
    input: 'speech',
    action,
    method: 'POST',
    language: 'en-US',
    speechTimeout: 'auto',
    hints
  });
  g.say({ voice: 'Polly.Joanna', language: 'en-US' }, text);
}

function offerText(index) {
  const o = OFFERS[index % OFFERS.length];
  return `We can offer you ${o.text}. Would you like to accept this offer? You can say yes or no.`;
}
function describeOffer(idx) {
  const o = OFFERS[idx % OFFERS.length];
  return o.text;
}

// Strict, unambiguous intent detectors
function acceptedOffer(text) {
  const t = text.toUpperCase();
  return /\b(YES|YEAH|YEP|OKAY|OK|SURE|ACCEPT|APPLY|TAKE)\b/.test(t);
}
function rejectedOffer(text) {
  const t = text.toUpperCase();
  // Do NOT treat generic "DON'T/DO NOT" as a "no" to avoid mishearing like "I don't know".
  return /\b(NO|NOPE|NAH|NOT INTERESTED|DECLINE|PASS|REFUND|RETURN ANYWAY)\b/.test(t);
}
function isYes(text) {
  return /\b(YES|YEAH|YEP|OKAY|OK|SURE)\b/i.test(text);
}
function isNo(text) {
  // Strict "no" only; avoid catching "don't know" etc.
  return /\b(NO|NOPE|NAH|NOT NOW|STOP|CANCEL)\b/i.test(text);
}
function wantsReturn(text) {
  return /(RETURN|REFUND|SEND BACK|CANCEL ORDER|EXCHANGE)/i.test(text);
}
// Strict keep: only accept explicit "keep" and variants, and ignore negated phrases
function wantsKeep(text) {
  const t = text.toUpperCase();
  if (/\b(DON'T|DO NOT|NO|NOT)\b.*\bKEEP\b/.test(t)) return false;
  return /\bKEEP(\s+(IT|THE\s+(ORDER|PRODUCT)))?\b/.test(t);
}
function wantsTransfer(text) {
  return /(TRANSFER|AGENT|REPRESENTATIVE|HUMAN|LIVE PERSON|SOMEONE|SUPERVISOR|MANAGER|TALK TO|SPEAK TO)/i.test(text);
}

// ------------------- Token Endpoint -------------------
app.get('/token', (req, res) => {
  let identity = req.query.identity || `user_${Math.floor(Math.random() * 10000)}`;
  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY,
    process.env.TWILIO_API_SECRET,
    { identity }
  );
  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: process.env.TWIML_APP_SID,
    incomingAllow: true
  });
  token.addGrant(voiceGrant);
  console.log(`[TOKEN] Generated for identity: ${identity}`);
  res.json({ token: token.toJwt(), identity });
});

// ------------------- Voice start -------------------
app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid || 'unknown';
  if (!SESSIONS.has(callSid)) {
    SESSIONS.set(callSid, { stage: 'verify_order', offerIndex: 0, order: null });
  }

  sayAndGather(
    twiml,
    'Hello! This is the delivery assistant. Please say your Order I D. For example, say: one two three.',
    '/gather?stage=verify_order',
    'one, two, three, numbers'
  );

  res.type('text/xml').send(twiml.toString());
});

// ------------------- Gather handler -------------------
app.post('/gather', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid || 'unknown';
  const session = SESSIONS.get(callSid) || { stage: 'verify_order', offerIndex: 0, order: null };
  const stage = (req.query.stage || session.stage || 'verify_order');
  const speech = (req.body.SpeechResult || '').trim();

  console.log(`[GATHER] stage=${stage} speech="${speech}" callSid=${callSid}`);

  // Global: anytime the caller asks for a transfer, say it and end call
  if (speech && wantsTransfer(speech)) {
    twiml.say('Okay, transferring the call. Goodbye.');
    twiml.hangup();
    session.stage = 'done';
    SESSIONS.set(callSid, session);
    return res.type('text/xml').send(twiml.toString());
  }

  // Handle no speech: re-prompt based on stage
  if (!speech) {
    switch (stage) {
      case 'verify_order':
        sayAndGather(twiml, 'I did not catch that. Please say your Order I D, like one two three.', '/gather?stage=verify_order');
        break;
      case 'after_delivery':
        sayAndGather(
          twiml,
          'If you want to return the product, say: I want to return. Otherwise say keep.',
          '/gather?stage=after_delivery',
          'return, keep, keep it'
        );
        break;
      case 'retention_offer':
        sayAndGather(
          twiml,
          'Please say yes to accept the offer or no to hear another offer.',
          '/gather?stage=retention_offer',
          'yes, no'
        );
        break;
      case 'human_offer':
        sayAndGather(
          twiml,
          'Would you like me to transfer you to a live human agent?',
          '/gather?stage=human_offer',
          'yes, no'
        );
        break;
      case 'return_confirm':
        sayAndGather(
          twiml,
          'Are you really sure you want to return the product? Please say yes or no.',
          '/gather?stage=return_confirm',
          'yes, no'
        );
        break;
      default:
        twiml.say('Goodbye.'); twiml.hangup();
    }
    return res.type('text/xml').send(twiml.toString());
  }

  // ------------------- Stage logic -------------------
  if (stage === 'verify_order') {
    const extracted = extractNumericOrderId(speech); // digits only
    if (extracted && ORDERS[extracted]) {
      session.order = ORDERS[extracted];
      session.stage = 'after_delivery';
      SESSIONS.set(callSid, session);

      const prompt = `Order ${session.order.id} for ${session.order.product} is scheduled for delivery on ${session.order.delivery}. 
If you want to return the product, say: I want to return. Otherwise say keep.`;
      sayAndGather(
        twiml,
        prompt,
        '/gather?stage=after_delivery',
        'return, keep, keep it'
      );
    } else {
      sayAndGather(
        twiml,
        "I couldn't find that order I D. Please say your order I D, for example: one two three.",
        '/gather?stage=verify_order',
        'one, two, three, numbers'
      );
    }
    return res.type('text/xml').send(twiml.toString());
  }

  if (stage === 'after_delivery') {
    if (wantsReturn(speech)) {
      session.stage = 'retention_offer';
      session.offerIndex = 0;
      SESSIONS.set(callSid, session);
      sayAndGather(
        twiml,
        `I can help with a return, but first, let me offer you something better. ${offerText(session.offerIndex)}`,
        '/gather?stage=retention_offer',
        'yes, no'
      );
    } else if (wantsKeep(speech)) {
      twiml.say('Okay, thanks for confirming. We will proceed with delivery as scheduled. Have a great day!');
      twiml.hangup();
    } else {
      // Unexpected/unclear response → re-prompt instead of assuming "keep"
      sayAndGather(
        twiml,
        'Sorry, I did not get that. If you want to return the product, say: I want to return. Otherwise say: keep.',
        '/gather?stage=after_delivery',
        'return, keep, keep it'
      );
    }
    return res.type('text/xml').send(twiml.toString());
  }

  if (stage === 'retention_offer') {
    // Accept offer only with clear affirmatives
    if (acceptedOffer(speech)) {
      const idx = session.offerIndex % OFFERS.length;
      const chosen = describeOffer(idx);
      twiml.say(`Okay, we will proceed with the delivery of this product with the offer of ${chosen}. Thank you!`);
      twiml.hangup();
      session.stage = 'done';
      SESSIONS.set(callSid, session);
      return res.type('text/xml').send(twiml.toString());
    }

    // Reject offer only with clear negatives
    if (rejectedOffer(speech) || isNo(speech)) {
      // If last offer was just rejected → ask about human transfer
      if (session.offerIndex >= OFFERS.length - 1) {
        session.stage = 'human_offer';
        SESSIONS.set(callSid, session);
        sayAndGather(
          twiml,
          'Would you like me to transfer you to a live human agent to help with your return?',
          '/gather?stage=human_offer',
          'yes, no'
        );
      } else {
        // Move to next offer
        session.offerIndex += 1;
        SESSIONS.set(callSid, session);
        sayAndGather(
          twiml,
          `No problem. How about this: ${offerText(session.offerIndex)}`,
          '/gather?stage=retention_offer',
          'yes, no'
        );
      }
      return res.type('text/xml').send(twiml.toString());
    }

    // Unclear/unrelated input → re-prompt (do NOT treat as "no")
    sayAndGather(
      twiml,
      'I did not catch that. You can say yes to accept or no to hear another offer.',
      '/gather?stage=retention_offer',
      'yes, no'
    );
    return res.type('text/xml').send(twiml.toString());
  }

  if (stage === 'human_offer') {
    if (isYes(speech)) {
      // New behavior: just say transferring and end the call (no actual transfer)
      twiml.say('Okay, transferring the call. Goodbye.');
      twiml.hangup();
      session.stage = 'done';
      SESSIONS.set(callSid, session);
      return res.type('text/xml').send(twiml.toString());
    }

    if (isNo(speech)) {
      session.stage = 'return_confirm';
      SESSIONS.set(callSid, session);
      sayAndGather(
        twiml,
        'Are you really sure you want to return the product? Please say yes or no.',
        '/gather?stage=return_confirm',
        'yes, no'
      );
      return res.type('text/xml').send(twiml.toString());
    }

    // Unclear/unrelated input → re-prompt
    sayAndGather(
      twiml,
      'Please say yes to transfer to a human agent, or no to continue.',
      '/gather?stage=human_offer',
      'yes, no'
    );
    return res.type('text/xml').send(twiml.toString());
  }

  if (stage === 'return_confirm') {
    if (isYes(speech)) {
      twiml.say('Okay. Your return request is confirmed. We will send you the return instructions by email. Thank you!');
      twiml.hangup();
      session.stage = 'done';
      SESSIONS.set(callSid, session);
      return res.type('text/xml').send(twiml.toString());
    }
    if (isNo(speech)) {
      twiml.say('Okay, we will proceed with delivery as scheduled. Thank you!');
      twiml.hangup();
      session.stage = 'done';
      SESSIONS.set(callSid, session);
      return res.type('text/xml').send(twiml.toString());
    }
    // Unclear/unrelated input → re-prompt
    sayAndGather(
      twiml,
      'Please say yes to confirm return or no to keep the order.',
      '/gather?stage=return_confirm',
      'yes, no'
    );
    return res.type('text/xml').send(twiml.toString());
  }

  // Fallback
  twiml.say('Thanks for calling. Goodbye.');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// ------------------- Cleanup when call ends -------------------
app.post('/status', (req, res) => {
  const callSid = req.body.CallSid;
  if (callSid) SESSIONS.delete(callSid);
  res.sendStatus(200);
});

// ------------------- Start server -------------------
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
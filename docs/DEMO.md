# The three-minute demo

Scene by scene, with the exact words and the numbers you should see.

---

## Before you start

```bash
npm install
cp .env.example .env
npm run seed -- --reset
npm run dev
```

Open <http://localhost:5173>.

**Two minutes of setup that will save the demo:**

- Use **Chrome on Android**, or desktop Chrome. The voice scene needs the Web
  Speech API, which Firefox does not implement.
- Allow the microphone once, before you present. The permission prompt mid-demo
  kills the pacing.
- If the room is loud, the voice scene has a **Type it instead** button that
  feeds the identical pipeline. Use it without apology — the interesting part is
  what happens *after* the words arrive.
- Take the tour once yourself. The seed is deterministic, so what you see in
  rehearsal is what you will see live.

### The seeded shop

**Sharma Stores**, Patna. 5 customers, ~120 sales over 45 days, 10 products,
~₹4,000 outstanding, 6 orders (4 ready).

The size comes from `FEATURED_CUSTOMERS` in `backend/scripts/seed.ts`. Visit
frequency is assigned in proportion to the list, so the spread of daily
regulars, occasional visitors and concentrated credit holds at any size.

Cooking Oil is deliberately left at about **two days of cover** — that is the
Shop Pulse card, and it is derived from the generated sales history rather than
hard-coded.

---

## 0:00 – 0:20 · The problem

Land on the marketing page. Read the headline:

> **Give your shop a memory.**

Say it in your own words:

> A shopkeeper knows four hundred customers by face. Who bought what. Who still
> owes five hundred rupees since Diwali. All of it is in one person's head, and
> in a notebook, and in WhatsApp, and nowhere you can search.

Scroll once to **"Your shop remembers. Your software doesn't."**

Then click **Try the demo shop**.

---

## 0:20 – 0:45 · Scan, and ask

You land on the home screen. Point at the top row — sales, estimated profit,
customers, pending — then straight past it to the priority cards. Say:

> This is not a dashboard. It is a list of what needs doing today.

**Tap SCAN** (the raised button in the bottom bar).

The camera opens with a viewfinder and a travelling scan line. You almost
certainly do not have a printed card, so:

> The scanner is real — it decodes a QR and resolves an opaque token. Let me use
> the fallback.

**Tap "Enter phone number instead"** and type Ramesh Kumar's number. Find it
first: **Customers → Ramesh Kumar**, and note the number shown.

The toast reads **"Got them! 👋"** and his memory opens.

Point at the header:

> Everything spent, every purchase, what is pending. Then a timeline — not a
> ledger. Today, yesterday, last week. What he bought and what he still owes.

Scroll the timeline briefly.

---

## 0:45 – 1:20 · Speak a sale

**Tap the microphone** (bottom right).

Mitra is idle. Tap the large orange button and say — in Hindi or Hinglish, at
normal speed:

> **"Ramesh ko 2 kilo chawal aur ek tel diya. 300 UPI kiya aur 120 baaki hai."**

The waveform moves with your actual voice. Tap the red button to stop.

Mitra thinks, and the review screen appears:

```
Ramesh Kumar

2 kg Rice
1 litre Cooking Oil

Total    ₹420
Paid     ₹300
Pending  ₹120
```

**This is the moment. Slow down.**

> It resolved "Ramesh" against real customers. It translated *chawal* to Rice
> and *tel* to Cooking Oil, and priced them from this shop's catalogue — not
> from anything the model made up. It understood that *baaki* means still owed,
> not paid.
>
> And look here —

Point at the warning:

> — it noticed the listed prices come to ₹276, not the ₹420 he said. It did not
> silently pick one. It is asking.
>
> Nothing has been written yet. This is a draft.

**Tap Confirm.**

> Now it is saved. The customer's balance went up by ₹120, two kilos of rice
> left the shelf, and a payment reminder became due — one write, all of it.

You land back on Ramesh's timeline with the new entry at the top.

---

## 1:20 – 1:55 · The agent

**More → AI Assistant.** Type:

> **"Find everyone who owes more than 500 and is overdue, and prepare payment
> reminders."**

The steps appear as it works:

```
✓ Understanding your request
✓ Checking outstanding balances   — 3 unpaid balances totalling ₹1,687
✓ Preparing reminders             — Prepared 3 reminders for ₹1,687
```

Then the proposal, with each customer listed by name and amount.

**Point at the line above the buttons:**

> Before I decide anything, it tells me what will actually happen. No messaging
> provider is configured here, so these will be recorded but **not sent**. It
> says so before I tap, not after.

**Tap "Send 3 reminders".**

The result is honest:

> **"Nothing was sent. 3 reminders were recorded in your reminder log —
> configure a messaging provider to deliver them."**

Say the line that matters:

> A lot of demos would have said "3 reminders sent" there. That would be a lie,
> and a shopkeeper who believes it stops chasing the money. Configure SNS and
> the same button genuinely sends — and then it says so.

Scroll down to **Recent actions**: every AI run is logged, with what it did and
who confirmed it.

---

## 1:55 – 2:25 · Shop Pulse

**Tap Home.**

The priority cards, in order:

```
⚠  Cooking Oil may run out in ~2 days     10 litre left · selling 5.14/day
⚠  13 customers owe ₹11,208               Oldest is 12 days past due
ℹ  4 orders are ready                     Priya Singh, Amit Shaw, Ramesh Kumar
ℹ  Sugar is below your reorder level
```

> Two days of cover is not a guess. It is stock divided by sales velocity, and
> velocity is computed from the inventory event log. The AI's only job is
> turning that number into a sentence — and the card reads correctly with the
> sentence missing, which is what happens when Bedrock is off.

**Tap "Add to restock"** → the Cooking Oil page: stock, velocity, days
remaining, margin, a suggested quantity and what it will cost, plus the movement
history behind the number.

---

## 2:25 – 2:45 · Shop Memory

**More → Shop Memory.** Type:

> **"Who bought rice and oil together?"**

```
17 customers bought Rice and Cooking Oil in the same purchase:
Gopal Chandra, Bhavna Desai, Ramesh Kumar, Nisha Thakur, Kavita Sharma,
Deepak Yadav.

From your records · 12
```

Worth pointing out, if you spot it:

> Ramesh is in that list because of the sale we spoke thirty seconds ago. It is
> the same data.

Point at the citations:

> Every answer comes with the actual sales it was drawn from. Tap one and you
> land on that customer.

Then ask something the shop cannot answer:

> **"Did anyone buy a helicopter?"**

```
I couldn't find enough information in your shop records.
```

> Retrieval found nothing, so the model was never called. There is nothing for
> it to fill the silence with.

---

## 2:45 – 3:00 · Close

Back to Home.

> We did not build another digital khata.
>
> We built a memory for the neighbourhood shop. It scans, it listens, it
> remembers, and it tells you what needs doing — and it never claims to have
> done something it hasn't.
>
> **Vyapio. Your shop. Your memory. Your AI.**

---

## If you have another minute

**Offline.** DevTools → Network → Offline. Record a sale. The banner reads
*"You're offline · 1 action waiting to sync"* and the button says **waiting to
sync**, not *saved*. Go back online: *"✓ 1 action synced"*.

**Language.** Settings → App language → हिन्दी. The whole interface switches
without a reload. Note that the voice language is a separate setting — plenty of
shopkeepers read English menus and speak Marathi.

**Dark mode.** Settings → Appearance. Warm paper becomes near-black; the accents
lift so they still read.

**The customer's QR.** A customer page → the QR icon. The card shows what the
code contains: a random token, no name, no number, no balance.

**Honesty, at the bottom of Settings.** Every subsystem listed with whether it
is AWS or local. That badge is why you can trust the rest of the demo.

---

## If something goes wrong

| | |
| --- | --- |
| Voice does nothing | Firefox has no Web Speech API. Use Chrome, or **Type it instead**. |
| Microphone blocked | Allow it in the address bar, reload. Or type. |
| Camera blocked | **Enter phone number instead** — always available, not just after a failure. |
| Numbers look wrong | `npm run seed -- --reset` |
| API unreachable | Check :4000 is up. `npm run dev:backend`. |
| Pulse has no Cooking Oil card | The shop was re-seeded at a different time. Re-run the seed. |

# BookBridge

A digital library for students. It has novels, stories and folktales, comics and picture books, poetry and plays, textbooks, and an encyclopedia. It runs in any web browser, on laptops, tablets, phones and Chromebooks, and the books work **without internet**.

## How to open it

Double-click **`index.html`**. It opens in the web browser (Chrome, Edge, Firefox or Safari).

## How to give it to students

You can do any of these:

1. **Copy the folder.** Copy the whole `library` folder onto each device, a USB stick or a shared drive, then open `index.html`. Keep all the files together.
2. **Put it on the school network.** Copy the folder to any web server (school intranet, a Raspberry Pi, a NAS). Students then open the address in their browser. No database or special software is needed.
   To share it straight from one computer over the school Wi-Fi, install [Node.js](https://nodejs.org) and run `node tools/serve.js` in the `library` folder. It prints the address students should open.
3. **Put it online for free.** Upload the folder to a free static host such as GitHub Pages, Netlify or Cloudflare Pages.

## What students can do

- Browse by section, or search by title, author or topic.
- Read inside the app. They can change the text size and the page colour (light, sepia or dark).
- Pick up where they stopped. The app remembers each student's place in every book.
- Save favourite books to **My Shelf** with ♡.
- Use **Encyclopedia** to look up any topic on Wikipedia, in Simple English or full English. This part needs internet.
- Use **More Online** to reach free sites such as OpenStax (modern textbooks), African Storybook and StoryWeaver.

Reading progress and saved books are kept on each device. No account or login is needed, and nothing is sent anywhere.

## Adding more books

1. Find a book on [gutenberg.org](https://www.gutenberg.org). Its number is in the web address, for example `gutenberg.org/ebooks/1342` is book `1342`.
2. Add the number to the right line in `tools/book-list.txt`. Textbooks take a subject, for example `12345:Science`.
3. Install [Node.js](https://nodejs.org). Then, in the `library` folder, run:

   ```
   node tools/add-books.js
   ```

The tool downloads the new books with their pictures and covers, then updates the library. Books you already have are skipped.

## Changing the library name

Open `assets/app.js` and change this line near the top:

```js
var LIBRARY_NAME = 'BookBridge';
```

## The website and payments

The public website runs on `server/server.js`. It needs Node.js 18 or newer. The only extra package is the MongoDB driver, used when accounts are kept in MongoDB (`npm install` gets it).

- `/` is the portfolio and pricing page (`portfolio.html`).
- `/index.html` is the library.
- `/terms.html`, `/privacy.html` and `/refunds.html` are the policies Paystack asks for.
- `/thanks.html` confirms each payment.

Payments work like SafeTab's:

1. A school picks a plan (monthly or per term).
2. It enters its details and chooses Mobile Money or card.
3. Paystack's secure window opens.
4. The server confirms the payment directly with Paystack before showing "Payment received". It checks the amount against the plan price.

Monthly card payments renew automatically through Paystack plans, which the server creates by itself. Mobile Money and per-term payments cover one period at a time.

The server also runs a **catch-up check**. When it starts or wakes up, and every 15 minutes while it runs, it asks Paystack for recent successful payments and records any it missed: monthly renewals, and payments where the customer closed the page before coming back. So payments are recorded even without the webhook, for example when the Paystack account's webhook already points at another website. Payments that belong to other websites on the same Paystack account are ignored.

Every payment is written to the payment log (the `orders` collection in MongoDB, or `orders.jsonl` in the data folder). Paystack's dashboard is the official record, and it emails you and the customer for every payment.

Prices, contact details and the business name are settings, not code. See `server/.env.example`.

### School accounts and student sign-in

On the website, the library is for signed-in students only. Book covers and the book list stay public, so the portfolio page can show them.

1. **Pay.** A school pays for a plan on the portfolio page.
2. **Create the admin account.** On the "Payment received" page, the school sets a password. The account uses the email they paid with. This only works in the browser they paid with, because a secret claim token proves they're the payer, like SafeTab.
3. **Add students.** In the **dashboard** (`/admin.html`), the admin pastes class lists, one student per line, like `Ama Mensah, Basic 6`. Every student gets:
   - a username, like `ama.mensah`
   - an easy password, like `mango-4821`
4. **Print login cards.** The admin prints cards or downloads a spreadsheet. Passwords are only shown once, so print them straight away. The admin can make a new password, turn a login off, or remove a student at any time.
5. **Students sign in.** Students go to `/login.html` and enter the **school code**, their username and password. The dashboard shows the school code and a sign-in link. Each student keeps their own reading progress, even on a shared device.

What happens as plans start and end:

| Situation | What happens |
|---|---|
| Plan limits | School: up to 1,000 students. Network: up to 5,000 students. Both can be changed in the settings. |
| Renewing | A signed-in admin renews from the dashboard. The new time is added after their current paid-until date. Monthly card subscriptions renew by themselves through Paystack's webhook. |
| Plan ends | Students can sign in for 7 more days. After that they see "ask your school to renew". Their logins are kept, so nothing needs to be set up again. |

Where accounts are stored:

- **MongoDB**, when `MONGODB_URI` is set. This is what the Render setup uses, because Render's free plan wipes its disk on every restart. Each school, admin, student, session and checkout is its own document in the `records` collection.
- **A file**, `accounts.json` in the data folder, when `MONGODB_URI` is not set. Back it up now and then.

**Support tool:**

```
node server/admin-cli.js schools                  list schools, plans and admins
node server/admin-cli.js reset-admin <email>      new temporary password for a school admin
node server/admin-cli.js extend <code> <days>     add days, e.g. after a bank-transfer payment
```

With MongoDB, run it on your own computer: run `npm install` once in the library folder, and put the same `MONGODB_URI` in `server/.env`. With the file, run it on the server itself. The website picks up the change within about 10 seconds.

### Go-live checklist

1. **Activate your Paystack business.** In the Paystack dashboard, submit your business documents for go-live, and use your live website address. Paystack checks that the site shows your Terms, Privacy and Refund pages.
2. **Make the free database.** On [MongoDB Atlas](https://www.mongodb.com/atlas), create a free **M0** cluster. Under **Database Access**, add a database user with a password. Under **Network Access**, allow `0.0.0.0/0`, because Render's free plan has no fixed address. Then **Connect → Drivers** shows the connection string, `mongodb+srv://...`. Put the user's password into it.
3. **Put the folder on GitHub.** The books make it about 730 MB, which is fine for GitHub. Then on [Render](https://render.com) choose **New → Blueprint** and pick the repository. It reads `render.yaml`, which uses Render's **free** plan.
4. **Fill in the settings Render asks for:**
   - `PUBLIC_BASE_URL`: your Render address, for example `https://bookbridge.onrender.com`.
   - `MONGODB_URI`: the connection string from step 2.
   - `PAYSTACK_SECRET_KEY`: start with the **test** key (`sk_test_...`).
   - `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `SUPPORT_WHATSAPP` and `BUSINESS_ADDRESS`.
5. **Add the webhook.** In Paystack → Settings → API Keys & Webhooks, set the webhook URL to `https://YOUR-SITE/api/paystack/webhook`. If the webhook is already used by another website on the same Paystack account, skip this: the catch-up check records BookBridge's payments anyway, just a little later.
6. **Test it.** The site shows a yellow "TEST mode" banner. Buy a plan with Paystack's test card or test Mobile Money, and check that you land on "Payment received".
7. **Go live.** Swap `PAYSTACK_SECRET_KEY` to the **live** key (`sk_live_...`) and save. The banner disappears, and real payments start.

To check prices, run `node server/server.js` on your own computer first, after copying `server/.env.example` to `server/.env` and filling it in. Then open http://localhost:8080.

## Where the books come from

Every book here is in the **public domain** and comes from [Project Gutenberg](https://www.gutenberg.org). The school can freely copy and share them. Encyclopedia articles come from Wikipedia under the CC BY-SA license.

"""Generate the WhatsApp OMS administrator guide (PDF).

Run:  python docs/make_admin_guide.py
Out:  docs/WhatsApp-OMS-Admin-Guide.pdf
"""

from datetime import date
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageBreak,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

OUT = Path(__file__).with_name("WhatsApp-OMS-Admin-Guide.pdf")

GREEN = colors.HexColor("#059669")
GREEN_DK = colors.HexColor("#065f46")
GREEN_BG = colors.HexColor("#eafaf0")
GREEN_LN = colors.HexColor("#a7f3d0")
INK = colors.HexColor("#111b21")
MUTE = colors.HexColor("#5b6b76")
LINE = colors.HexColor("#dde3e7")
PANEL = colors.HexColor("#f5f7f8")
AMBER_BG = colors.HexColor("#fffbeb")
AMBER_LN = colors.HexColor("#fde68a")
AMBER_TX = colors.HexColor("#8a5a08")

ss = getSampleStyleSheet()


def st(name, **kw):
    base = dict(fontName="Helvetica", fontSize=9.7, leading=14.2, textColor=INK)
    base.update(kw)
    return ParagraphStyle(name, parent=ss["Normal"], **base)


BODY = st("body", spaceAfter=6)
LEAD = st("lead", fontSize=10.6, leading=15.5, textColor=MUTE, spaceAfter=10)
H1 = st("h1", fontName="Helvetica-Bold", fontSize=17, leading=21, textColor=GREEN_DK,
        spaceBefore=4, spaceAfter=9)
H2 = st("h2", fontName="Helvetica-Bold", fontSize=11.6, leading=15, textColor=INK,
        spaceBefore=13, spaceAfter=5)
SMALL = st("small", fontSize=8.6, leading=12.4, textColor=MUTE)
CELL = st("cell", fontSize=9.2, leading=12.8)
CELL_B = st("cellb", fontName="Helvetica-Bold", fontSize=9.2, leading=12.8)
MONO = st("mono", fontName="Courier-Bold", fontSize=9.6, leading=13.4, textColor=GREEN_DK)
STEP = st("step", fontSize=9.7, leading=14.2, leftIndent=13, bulletIndent=2, spaceAfter=3)
TITLE = st("title", fontName="Helvetica-Bold", fontSize=26, leading=30,
           textColor=GREEN_DK, alignment=TA_CENTER, spaceAfter=4)
SUB = st("sub", fontSize=11.4, leading=16, textColor=MUTE, alignment=TA_CENTER)


def para(txt, style=BODY):
    return Paragraph(txt, style)


def bullets(items, style=STEP):
    return [Paragraph(t, style, bulletText="•") for t in items]


def steps(items):
    return [Paragraph(t, STEP, bulletText=f"{i}.") for i, t in enumerate(items, 1)]


def callout(title, body, kind="info"):
    """Coloured panel used for warnings and key notes."""
    bg, ln, tx = (GREEN_BG, GREEN_LN, GREEN_DK)
    if kind == "warn":
        bg, ln, tx = (AMBER_BG, AMBER_LN, AMBER_TX)
    inner = [
        Paragraph(title, st("cot", fontName="Helvetica-Bold", fontSize=9.6, leading=13, textColor=tx)),
        Paragraph(body, st("cob", fontSize=9.3, leading=13.4, textColor=tx)),
    ]
    t = Table([[inner]], colWidths=[165 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.7, ln),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return t


def table(rows, widths, header=True):
    data = []
    for r_i, row in enumerate(rows):
        style = CELL_B if (header and r_i == 0) else CELL
        data.append([Paragraph(str(c), style) for c in row])
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    cmds = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, LINE),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
    ]
    if header:
        cmds += [("BACKGROUND", (0, 0), (-1, 0), PANEL),
                 ("LINEBELOW", (0, 0), (-1, 0), 0.9, LINE)]
    t.setStyle(TableStyle(cmds))
    return t


def cover_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(GREEN)
    canvas.rect(0, A4[1] - 14 * mm, A4[0], 14 * mm, stroke=0, fill=1)
    canvas.setFillColor(MUTE)
    canvas.setFont("Helvetica", 8)
    canvas.drawCentredString(A4[0] / 2, 12 * mm, "YS Plumbing — internal document")
    canvas.restoreState()


def inner_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(GREEN)
    canvas.rect(0, A4[1] - 5 * mm, A4[0], 5 * mm, stroke=0, fill=1)
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(20 * mm, 15 * mm, A4[0] - 20 * mm, 15 * mm)
    canvas.setFillColor(MUTE)
    canvas.setFont("Helvetica", 8)
    canvas.drawString(20 * mm, 10 * mm, "WhatsApp OMS — Administrator Guide")
    canvas.drawRightString(A4[0] - 20 * mm, 10 * mm, f"Page {canvas.getPageNumber() - 1}")
    canvas.restoreState()


def build():
    doc = BaseDocTemplate(str(OUT), pagesize=A4,
                          leftMargin=20 * mm, rightMargin=20 * mm,
                          topMargin=22 * mm, bottomMargin=20 * mm,
                          title="WhatsApp OMS — Administrator Guide",
                          author="YS Plumbing")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")
    from reportlab.platypus import PageTemplate
    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[frame], onPage=cover_page),
        PageTemplate(id="inner", frames=[frame], onPage=inner_page),
    ])

    s = []

    # ---------------- cover ----------------
    s += [Spacer(1, 42 * mm),
          para("WhatsApp OMS", TITLE),
          para("Order Management System — Administrator Guide", SUB),
          Spacer(1, 14 * mm)]

    s += [table([
        ["Website", '<font face="Courier-Bold" color="#065f46">https://oms.ysps.shop</font>'],
        ["Username", '<font face="Courier-Bold" color="#065f46">admin</font>'],
        ["Password", "Set by you at first sign-in. To reset, see <b>Resetting a password</b> on page 4."],
        ["Prepared", date.today().strftime("%d %B %Y")],
    ], [38 * mm, 127 * mm], header=False)]

    s += [Spacer(1, 10 * mm),
          callout("What this system does",
                  "It reads your WhatsApp order groups, turns customer messages into matched product "
                  "lines with SKUs, and lets your team reply — all from one web page, with a record "
                  "of who did what.")]

    s += [Spacer(1, 8 * mm),
          callout("Keep this document internal",
                  "Anyone with the link and a login can read every customer conversation and send "
                  "messages as your business. Do not share it outside the company.", "warn")]

    s += [PageBreak()]

    # ---------------- getting started ----------------
    s += [para("1. Getting started", H1),
          para("The system runs on your own server and is reachable from anywhere at "
               "<font face='Courier-Bold' color='#065f46'>https://oms.ysps.shop</font>. "
               "Nothing needs installing — any modern browser works, on desktop or phone.", LEAD)]

    s += [para("Signing in", H2)]
    s += steps([
        "Open <font face='Courier-Bold'>https://oms.ysps.shop</font>.",
        "Enter your username and password.",
        "First-time users are asked to choose their own password before continuing.",
    ])

    s += [Spacer(1, 4),
          callout("Every user gets their own login",
                  "Do not share one account. Replies are stamped with the username of whoever sent "
                  "them, so individual logins are what make that record meaningful.")]

    s += [para("The screen at a glance", H2),
          table([
            ["Area", "What it is for"],
            ["Left — chat list", "Every WhatsApp chat. Unread chats rise to the top with a green count."],
            ["Middle — conversation", "The messages, exactly as in WhatsApp. Type here to reply."],
            ["Right — order panel", "Products found in the message you selected, ready to copy."],
            ["Top right — status", "Green <b>Live chat</b> means WhatsApp is connected."],
          ], [42 * mm, 123 * mm])]

    s += [PageBreak()]

    # ---------------- daily use ----------------
    s += [para("2. Processing an order", H1),
          para("The core routine your team will repeat all day.", LEAD)]

    s += steps([
        "Click a chat on the left. Chats with new messages appear at the top with a green badge.",
        "Find the customer's order message and click it. The system reads the products out of it.",
        "The right panel fills with <b>Matched</b> items (a product was recognised) and "
        "<b>Unmatched</b> items (it needs your help).",
        "For each unmatched line, click it and search for the correct product. Your choice is "
        "remembered — next time that wording matches automatically.",
        "Adjust quantities in the small box on the left of each row if needed.",
        "Click <b>Copy</b>. The order is copied to your clipboard as quantity and SKU, ready to "
        "paste into your ordering system.",
    ])

    s += [Spacer(1, 4),
          callout("The system learns from your corrections",
                  "Every unmatched item you resolve is saved permanently. Matching starts basic and "
                  "gets noticeably better over the first few weeks of real use.")]

    s += [para("What the labels mean", H2),
          table([
            ["Label", "Meaning"],
            ["<b>Extract</b>", "Click a message to pull products out of it."],
            ["<b>Extracted</b>", "This message's products are in the panel on the right."],
            ["<b>Processed</b>", "The order was copied. Shows who completed it."],
            ["<b>Re-Extract</b>", "Already processed — click to load it again."],
          ], [40 * mm, 125 * mm])]

    s += [para("Buttons in the order panel", H2),
          table([
            ["Button", "What it does"],
            ["<b>Copy</b>", "Copies the order and marks the message processed. If copying fails it "
                            "says so and marks nothing."],
            ["<b>Clear</b>", "Empties the panel. Does not undo anything already copied."],
          ], [30 * mm, 135 * mm])]

    s += [PageBreak()]

    # ---------------- replying ----------------
    s += [para("3. Replying to customers", H1),
          para("Type in the box at the bottom of the conversation and press <b>Enter</b>. "
               "Use <b>Shift + Enter</b> for a new line within the same message.", LEAD)]

    s += [para("Tagging someone", H2),
          para("Type <font face='Courier-Bold'>@</font> and a list of people in that chat appears. "
               "Keep typing to narrow it, then press Enter or click a name. The person is properly "
               "tagged in WhatsApp and receives a notification.", BODY)]

    s += [para("How replies are marked", H2),
          para("Every message sent from this system carries a signature so anyone reading WhatsApp "
               "can see it came from the OMS and who wrote it:", BODY),
          Spacer(1, 2)]

    # NOTE: the real signature starts with a writing-hand emoji. The PDF base fonts have no
    # emoji glyphs (it would render as a black box), so it is described in the caption instead.
    sig = Table([[Paragraph("Delivery is on the truck, arriving 7am<br/><br/>"
                            "BY <b>ADMIN</b>", CELL)]],
                colWidths=[165 * mm])
    sig.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#d9fdd3")),
        ("BOX", (0, 0), (-1, -1), 0.6, GREEN_LN),
        ("LEFTPADDING", (0, 0), (-1, -1), 12), ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 9), ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    s += [sig, Spacer(1, 3),
          para("In WhatsApp that last line begins with a small writing-hand emoji, followed by "
               "<b>BY</b> and the username in bold.", SMALL),
          Spacer(1, 6)]

    s += [para("Inside the OMS that line is hidden and shown instead as a green "
               "<b>Sent by &lt;username&gt;</b> tag, so the conversation stays clean. Messages typed "
               "directly in WhatsApp on a phone have no signature and no tag — which is exactly how "
               "you tell the two apart.", BODY)]

    s += [Spacer(1, 4),
          callout("Send carefully — these are real customers",
                  "There is no undo. Messages go to live customer groups the moment you press Enter. "
                  "Send one message at a time and never use this for bulk messaging.", "warn")]

    s += [PageBreak()]

    # ---------------- admin ----------------
    s += [para("4. Administrator tasks", H1),
          para("Only administrators see the <b>Users</b> link in the header.", LEAD)]

    s += [para("Adding a user", H2)]
    s += steps([
        "Click <b>Users</b> in the top-right, then <b>+ Add user</b>.",
        "Enter a username — letters and numbers only, no spaces or symbols.",
        "Enter their full name, choose <b>User</b> or <b>Admin</b>, and set a temporary password.",
        "Give them the temporary password. They must change it when they first sign in.",
    ])

    s += [Spacer(1, 3),
          callout("Why usernames have no spaces",
                  "The username appears in the signature on every message sent. A space would make "
                  "that line impossible to read back reliably, so the rule is enforced.")]

    s += [para("Removing or suspending someone", H2),
          para("Use <b>Edit</b> to set a user to <b>Disabled</b> — they are signed out everywhere "
               "immediately, and their past activity is preserved. Use <b>Delete</b> to remove the "
               "account entirely. You cannot delete or disable yourself, and the last administrator "
               "cannot be removed.", BODY)]

    s += [para("Resetting a password", H2),
          para("Use <b>Edit</b> on the user and set a new password; they will be asked to change it "
               "at next sign-in. If nobody can sign in at all, run this on the server:", BODY),
          Spacer(1, 2),
          Paragraph("cd C:\\Whatsapp_OMS\\services\\whatsapp-ingestion<br/>"
                    "npm run set-password -- admin YourNewPassword", MONO),
          Spacer(1, 4),
          para("Roles: <b>Admin</b> can manage users and re-link WhatsApp. <b>User</b> can read "
               "chats, process orders and reply — nothing else.", BODY)]

    s += [para("The product catalogue", H2),
          para("Product data refreshes itself from the DDI export email. Nobody needs to upload "
               "anything — the system checks the mailbox twice a day, shortly after each export "
               "arrives, and loads the new catalogue without interrupting anyone using the site.", BODY)]

    s += [table([
        ["Runs at", "23:30 and 11:30 every day"],
        ["Reads from", "<font face='Courier'>ysddiexport@gmail.com</font> — emails with "
                       "<b>ZTMPEXP</b> in the subject"],
        ["Report sent to", "<font face='Courier'>ruturajysps@gmail.com</font> after every run"],
        ["Run it manually", "<font face='Courier'>npm run import:products</font>"],
    ], [38 * mm, 127 * mm], header=False)]

    s += [Spacer(1, 5),
          callout("Watch the report email",
                  "A report arrives after every run, whether it succeeded or failed. If one says "
                  "failed — or they stop arriving altogether — the catalogue has stopped updating "
                  "and prices or stock may be going stale.")]

    s += [Spacer(1, 4),
          para("Two safeguards are built in. The mailbox is opened <b>read-only</b>, so nothing is "
               "marked as read, moved or deleted and the existing customer-portal import is "
               "unaffected. And an export with fewer than 1,000 rows is <b>rejected</b> rather than "
               "loaded, so a truncated file cannot wipe the catalogue. Every download is kept in "
               "the <font face='Courier'>imports</font> folder as a record.", BODY)]

    s += [PageBreak()]

    # ---------------- troubleshooting ----------------
    s += [para("5. If something goes wrong", H1),
          para("The status pill in the top right tells you the state of the WhatsApp connection.", LEAD)]

    s += [table([
        ["You see", "What it means", "What to do"],
        ["Green <b>Live chat</b>", "Everything is working.", "Nothing."],
        ["<b>Blurred screen</b>, “Connecting…”",
         "Starting up or briefly reconnecting.",
         "Wait about a minute. It clears itself."],
        ["<b>Blurred screen</b>, “needs to be re-linked”",
         "WhatsApp signed the device out.",
         "An admin must re-link — see below."],
        ["<b>Cannot reach the server</b>",
         "Your internet or the server is down.",
         "Check your connection, then reload."],
    ], [46 * mm, 58 * mm, 61 * mm])]

    s += [para("Re-linking WhatsApp (administrators only)", H2)]
    s += steps([
        "On the server, open <font face='Courier-Bold'>http://localhost:3009/qr</font>.",
        "On the business phone: WhatsApp → <b>Linked devices</b> → <b>Link a device</b>.",
        "Scan the code. The blurred screen clears within a few seconds.",
    ])

    s += [Spacer(1, 3),
          callout("The QR page is deliberately blocked from the public address",
                  "Scanning that code links a phone to your business WhatsApp with full access. It "
                  "can only be opened on the server itself, and only by an administrator.", "warn")]

    s += [para("Good to know", H2)]
    s += bullets([
        "<b>Nothing is lost while disconnected.</b> WhatsApp holds messages and the system collects "
        "them when it reconnects.",
        "<b>It restarts itself.</b> Both the app and the secure tunnel start automatically after a "
        "server reboot, and the connection repairs itself if it ever hangs.",
        "<b>Order history is yours.</b> Messages, matches and learned products are stored in a "
        "database on your own server, not in WhatsApp.",
    ])

    s += [PageBreak()]

    # ---------------- reference ----------------
    s += [para("6. Reference", H1)]

    s += [para("Pages", H2),
          table([
            ["Address", "Who can open it"],
            ["<font face='Courier-Bold'>oms.ysps.shop</font>", "Order matching — everyone"],
            ["<font face='Courier-Bold'>oms.ysps.shop/aliases</font>", "Learned product names — everyone"],
            ["<font face='Courier-Bold'>oms.ysps.shop/admin</font>", "User management — administrators"],
            ["<font face='Courier-Bold'>localhost:3009/qr</font>", "Re-link WhatsApp — administrators, on the server"],
          ], [62 * mm, 103 * mm])]

    s += [para("Keyboard shortcuts", H2),
          table([
            ["Key", "Action"],
            ["<b>Enter</b>", "Send the message"],
            ["<b>Shift + Enter</b>", "New line in the same message"],
            ["<b>@</b>", "Tag someone in the chat"],
            ["<b>&#8593; &#8595;</b> then <b>Enter</b>", "Pick a name from the tag list"],
            ["<b>Esc</b>", "Close the tag list"],
          ], [46 * mm, 119 * mm])]

    s += [para("On the server", H2),
          table([
            ["Purpose", "Command"],
            ["Check it is running", "<font face='Courier'>sc query WhatsappOMS</font>"],
            ["Restart the system", "<font face='Courier'>Restart-Service WhatsappOMS</font>"],
            ["Reset a password", "<font face='Courier'>npm run set-password -- admin NewPass123</font>"],
            ["View recent activity", "<font face='Courier'>Get-Content logs\\service.out.log -Tail 40</font>"],
          ], [46 * mm, 119 * mm])]

    s += [Spacer(1, 8),
          callout("One limitation worth knowing",
                  "This system connects through WhatsApp Web, the same way a linked laptop does. "
                  "Meta's official business API cannot be used here because it cannot send into "
                  "group chats that customers created — and group chats are where your orders "
                  "arrive. Keep replies human-paced and never automate sending.", "warn")]

    s += [Spacer(1, 6),
          para(f"Document generated {date.today().strftime('%d %B %Y')} · "
               "WhatsApp OMS Administrator Guide", SMALL)]

    doc.build(s)
    print(f"written: {OUT}  ({OUT.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    build()

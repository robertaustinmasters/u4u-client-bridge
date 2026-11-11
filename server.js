require('dotenv').config();
const express = require('express');
const { Client } = require('@notionhq/client');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { google } = require('googleapis');
const fs = require('fs');

const app = express();
app.use(express.json());

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// ---------------------------------------------------------
// GOOGLE WORKSPACE: Zero-Touch Client Onboarding
// ---------------------------------------------------------
let auth;
try {
    if (fs.existsSync('./google-credentials.json')) {
        auth = new google.auth.GoogleAuth({
            keyFile: './google-credentials.json',
            scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/documents'],
        });
    }
} catch (e) {
    console.warn('[Google Auth] Waiting for valid google-credentials.json configuration.');
}

app.post('/webhook/onboard-client', async (req, res) => {
    const { clientName, clientEmail } = req.body;

    try {
        console.log(`[Google Workspace] Initializing environment for ${clientName}...`);
        const drive = google.drive({ version: 'v3', auth });
        
        const folderMetadata = {
            name: `Client: ${clientName}`,
            mimeType: 'application/vnd.google-apps.folder',
        };
        const folder = await drive.files.create({
            resource: folderMetadata,
            fields: 'id',
        });
        const folderId = folder.data.id;
        console.log(`[Drive] Created Folder ID: ${folderId}`);

        const TEMPLATE_DOC_ID = process.env.GOOGLE_SOW_TEMPLATE_ID; 
        const copyMetadata = {
            name: `${clientName} - Statement of Work`,
            parents: [folderId]
        };
        
        const copiedFile = await drive.files.copy({
            fileId: TEMPLATE_DOC_ID,
            resource: copyMetadata,
        });
        console.log(`[Docs] Drafted SOW: ${copiedFile.data.id}`);

        res.status(200).json({ success: true, folderId, sowId: copiedFile.data.id });
    } catch (err) {
        console.error('[Google API Error]', err.message);
        res.status(500).send('Google Workspace Provisioning Failed');
    }
});

// ---------------------------------------------------------
// GITHUB SYNC: Moves Notion task to 'Done' on PR Merge
// ---------------------------------------------------------
app.post('/webhook/github', async (req, res) => {
    const { action, pull_request } = req.body;
    if (action === 'closed' && pull_request && pull_request.merged) {
        console.log(`[GitHub] PR Merged: ${pull_request.title}`);
        const match = pull_request.title.match(/\[(N-\d+)\]/);
        if (match) {
            const taskId = match[1];
            try {
                const response = await notion.databases.query({
                    database_id: NOTION_DATABASE_ID,
                    filter: { property: 'Task ID', rich_text: { equals: taskId } }
                });
                if (response.results.length > 0) {
                    await notion.pages.update({
                        page_id: response.results[0].id,
                        properties: { Status: { status: { name: 'Done' } } }
                    });
                    console.log(`[Notion] Task ${taskId} successfully marked as Done.`);
                }
            } catch (err) { console.error('[Notion Error]', err.message); }
        }
    }
    res.status(200).send('GitHub Webhook Received');
});

// ---------------------------------------------------------
// STRIPE SYNC: Generates Invoice when Notion Task is Done
// ---------------------------------------------------------
app.post('/webhook/notion-to-stripe', async (req, res) => {
    const { clientEmail, taskName, amount } = req.body;
    try {
        let customers = await stripe.customers.list({ email: clientEmail, limit: 1 });
        let customerId = customers.data.length > 0 ? customers.data[0].id : null;
        
        if (!customerId) {
            const newCustomer = await stripe.customers.create({ email: clientEmail });
            customerId = newCustomer.id;
        }

        await stripe.invoiceItems.create({
            customer: customerId,
            price_data: {
                currency: 'usd',
                product_data: { name: `Consulting Deliverable: ${taskName}` },
                unit_amount: amount * 100,
            },
        });

        const invoice = await stripe.invoices.create({
            customer: customerId,
            auto_advance: true,
        });
        console.log(`[Stripe] Invoice Drafted: ${invoice.id}`);
        res.status(200).json({ success: true, invoiceUrl: invoice.hosted_invoice_url });
    } catch (err) {
        console.error('[Stripe Error]', err.message);
        res.status(500).send('Stripe Invoice Failed');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[U4U Bridge] V2 Unified Integration Server active on port ${PORT}`);
});

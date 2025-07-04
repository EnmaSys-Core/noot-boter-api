// This is a Vercel Serverless Function that will be triggered by an Airtable Automation.
// It updates a single record in the "Sellable Products Table" (SPT).

// We need the 'node-fetch' library to make API calls to Airtable.
// Vercel doesn't include this by default, so we need to install it.
// In your terminal, in the 'noot-boter-api' folder, run: npm install node-fetch
import fetch from 'node-fetch';

// This is the main function that Vercel will run.
// 'request' contains the data sent from Airtable.
// 'response' is what we send back to Airtable.
export default async function handler(request, response) {
    // --- Security Check ---
    // This ensures that the function can only be called via a POST request, which is what our Airtable automation will do.
    if (request.method !== 'POST') {
        return response.status(405).json({ message: 'Method Not Allowed' });
    }

    console.log("Function triggered by Airtable.");

    // --- Get Secrets from Vercel Environment Variables ---
    // These are the secure variables you set up in your Vercel project settings.
    const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

    // --- Get Record ID from Airtable's Request ---
    // When Airtable calls this function, it will send the ID of the record to update.
    const { sptRecordId } = request.body;

    if (!sptRecordId) {
        console.error("Error: sptRecordId was not provided in the request body.");
        return response.status(400).json({ error: "sptRecordId is required." });
    }

    console.log(`Processing update for SPT Record ID: ${sptRecordId}`);

    try {
        // --- Step 1: Fetch the SPT record to get its linkedBaseProductId ---
        const sptTableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Sellable%20Products%20Table/${sptRecordId}`;
        const sptResponse = await fetch(sptTableUrl, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}` }
        });

        if (!sptResponse.ok) {
            throw new Error(`Failed to fetch SPT record: ${await sptResponse.text()}`);
        }

        const sptRecord = await sptResponse.json();
        const linkedBaseId = sptRecord.fields.linkedBaseProductId;
        const internalName = sptRecord.fields.internalName;
        const sptId = sptRecord.fields.sptId;

        if (!linkedBaseId) {
            throw new Error("The 'linkedBaseProductId' field is empty in the SPT record.");
        }
        console.log(`Found linkedBaseProductId: ${linkedBaseId}`);


        // --- Step 2: Fetch the matching MTB record using a formula ---
        // We construct a URL that tells Airtable to find the record in the MTB where the baseProductId matches our linkedBaseId.
        const mtbTableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Prices%2C%20purchase%2C%20and%20sell?filterByFormula=%7BbaseProductId%7D%3D'${linkedBaseId}'`;
        const mtbResponse = await fetch(mtbTableUrl, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}` }
        });

        if (!mtbResponse.ok) {
            throw new Error(`Failed to fetch MTB record: ${await mtbResponse.text()}`);
        }

        const mtbData = await mtbResponse.json();
        if (mtbData.records.length === 0) {
            throw new Error(`No matching record found in MTB for baseProductId: ${linkedBaseId}`);
        }
        const mtbRecord = mtbData.records[0];
        console.log("Successfully found matching MTB record:", mtbRecord.fields.internalName);


        // --- Step 3: Derive all the new values for the SPT record ---
        const updates = {};
        const nameMatch = internalName.match(/-\s*(z\d+|nb\d+)$/);
        const variantSuffix = nameMatch ? nameMatch[1] : null;

        let packageSize = null, sellingPrice = null, weightGrams = null;

        if (variantSuffix === "z450") {
            packageSize = "450g Bag";
            sellingPrice = mtbRecord.fields["Verkoop 450g (€/kg)"];
            weightGrams = 600;
        } else if (variantSuffix === "z1000") {
            packageSize = "1kg Bag";
            sellingPrice = mtbRecord.fields["Verkoop 1kg (€/kg)"];
            weightGrams = 1250;
        } else if (variantSuffix === "nb175") {
            packageSize = "175g Jar";
            sellingPrice = mtbRecord.fields["Nut Butter 175g (€/potje)"];
            weightGrams = 400;
        } else if (variantSuffix === "nb365") {
            packageSize = "365g Jar";
            sellingPrice = mtbRecord.fields["Nut Butter 365g (€/pot)"];
            weightGrams = 750;
        }

        updates.packageSize = packageSize;
        updates.sellingPrice = sellingPrice;
        updates.weightGrams = weightGrams;

        let productType = null;
        if (packageSize?.includes("Bag")) productType = "Nut Bag";
        else if (packageSize?.includes("Jar")) productType = "Nut Butter Jar";
        updates.productType = productType;

        let category = null;
        const baseProductGroup = mtbRecord.fields.baseProductGroup?.toLowerCase() || '';
        if (productType === "Nut Butter Jar") category = "Nut Butters";
        else if (baseProductGroup.includes("mix")) category = "Mixes";
        else category = "Whole Nuts";
        updates.category = category;

        updates.supplierProductName = mtbRecord.fields.supplierProductName;
        updates.baseProductGroup = mtbRecord.fields.baseProductGroup;
        updates.Ingredients = mtbRecord.fields.Ingredients;
        updates.countryOfOrigin = mtbRecord.fields.countryOfOrigin;
        updates.supplierProductUrl = mtbRecord.fields.supplierProductUrl;
        updates.isOrganic = mtbRecord.fields.isOrganic;
        updates.isRaw = mtbRecord.fields.isRaw;
        updates.isGeroosterd = mtbRecord.fields.isGeroosterd;
        updates.isGebrand = mtbRecord.fields.isGebrand;
        updates.isSalted = mtbRecord.fields.isSalted;
        updates.isNutbutterAvailable = mtbRecord.fields.isNutbutterAvailable;
        updates.imageUrl = `/images/${sptId}.jpg`;
        updates.marketingName = internalName;

        const ingredientsText = mtbRecord.fields.Ingredients || "";
        const allergenMatches = ingredientsText.match(/\b([A-Z][A-Z\s]+)\b/g) || [];
        updates.allergens = allergenMatches.map(allergen => {
            const cleaned = allergen.trim().toLowerCase();
            return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
        });

        updates.updateRecord = false; // Uncheck the box

        console.log("Applying updates:", updates);

        // --- Step 4: Send the updates back to the SPT record ---
        const updateResponse = await fetch(sptTableUrl, {
            method: 'PATCH', // PATCH updates only the fields we provide
            headers: {
                'Authorization': `Bearer ${AIRTABLE_PAT}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ fields: updates })
        });

        if (!updateResponse.ok) {
            throw new Error(`Failed to update SPT record: ${await updateResponse.text()}`);
        }

        console.log("Successfully updated SPT record.");
        // --- Success ---
        // Send a success response back to Airtable.
        return response.status(200).json({ message: "Record updated successfully." });

    } catch (error) {
        // --- Error Handling ---
        // If anything goes wrong, log the error and send a failure response.
        console.error("An error occurred:", error);
        return response.status(500).json({ error: error.message });
    }
}
// This function is now ready to be deployed on Vercel.
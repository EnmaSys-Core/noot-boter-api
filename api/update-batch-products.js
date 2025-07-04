import fetch from 'node-fetch';

// Helper function to add a delay, respecting Airtable's rate limit.
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Airtable API Configuration ---
const AIRTABLE_API_URL = 'https://api.airtable.com/v0';

// This function fetches the schema for a specific table to get the options for select fields.
// This is more robust than relying on text names.
async function getSelectOptions(baseId, pat, tableName) {
    const url = `https://api.airtable.com/v0/meta/bases/${baseId}/tables`;
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${pat}` } });
    if (!response.ok) throw new Error(`Failed to fetch base schema: ${await response.text()}`);
    const schema = await response.json();
    
    const table = schema.tables.find(t => t.name === tableName);
    if (!table) throw new Error(`Table '${tableName}' not found in base schema.`);

    const optionsMap = {};
    for (const field of table.fields) {
        if (field.type === 'singleSelect' || field.type === 'multipleSelects') {
            optionsMap[field.name] = new Map(
                field.options.choices.map(choice => [choice.name, choice.id])
            );
        }
    }
    return optionsMap;
}


export default async function handler(request, response) {
    // --- Security & Setup ---
    if (request.method !== 'POST') {
        return response.status(405).json({ error: 'Method Not Allowed' });
    }

    const { password } = request.body;
    const { AIRTABLE_PAT, AIRTABLE_BASE_ID, UPDATE_PASSWORD } = process.env;

    if (password !== UPDATE_PASSWORD) {
        return response.status(401).json({ error: 'Invalid password.' });
    }

    console.log("Password accepted. Starting batch update.");
    const logDetails = [];

    try {
        const sptTableName = "SPT - Sellable Product Table";
        const mtbTableName = "MTB - Prices, purchase and sell";

        // --- Step 1: Fetch Select Field Options for robust updates ---
        logDetails.push("Fetching field options from Airtable schema...");
        const selectOptions = await getSelectOptions(AIRTABLE_BASE_ID, AIRTABLE_PAT, sptTableName);
        console.log("Successfully fetched select options.");

        // --- Step 2: Fetch all records from the "Batch Update" view in SPT ---
        const viewName = "Batch Update";
        const sptTableUrl = `${AIRTABLE_API_URL}/${AIRTABLE_BASE_ID}/${encodeURIComponent(sptTableName)}?view=${encodeURIComponent(viewName)}`;
        
        logDetails.push(`Fetching records from view: ${viewName}`);
        const sptResponse = await fetch(sptTableUrl, { headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}` } });
        if (!sptResponse.ok) throw new Error(`Failed to fetch SPT records: ${await sptResponse.text()}`);
        const sptData = await sptResponse.json();
        const recordsToUpdate = sptData.records;

        if (recordsToUpdate.length === 0) {
            logDetails.push("No records found in the 'Batch Update' view. Nothing to do.");
            return response.status(200).json({ message: "No records to update.", details: logDetails });
        }
        logDetails.push(`Found ${recordsToUpdate.length} records to update.`);

        // --- Step 3: Fetch ALL records from MTB to create a lookup map ---
        const mtbTableUrl = `${AIRTABLE_API_URL}/${AIRTABLE_BASE_ID}/${encodeURIComponent(mtbTableName)}`;
        const mtbResponse = await fetch(mtbTableUrl, { headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}` } });
        if (!mtbResponse.ok) throw new Error(`Failed to fetch MTB records: ${await mtbResponse.text()}`);
        const mtbData = await mtbResponse.json();
        const mtbLookup = new Map(mtbData.records.map(rec => [rec.fields.baseProductId, rec.fields]));
        console.log(`Created lookup map with ${mtbLookup.size} MTB records.`);

        // --- Step 4: Loop through each SPT record and prepare the updates ---
        const updatePayloads = [];
        for (const sptRecord of recordsToUpdate) {
            const linkedBaseId = sptRecord.fields.linkedBaseProductId;
            if (!linkedBaseId) continue;
            const mtbRecordFields = mtbLookup.get(linkedBaseId);
            if (!mtbRecordFields) continue;
            
            const updates = {};
            const internalName = sptRecord.fields.internalName;
            const sptId = sptRecord.fields.sptId;
            const nameMatch = internalName.match(/-\s*(z\d+|nb\d+)$/);
            const variantSuffix = nameMatch ? nameMatch[1] : null;

            let packageSize = null, sellingPrice = null, weightGrams = null;

            if (variantSuffix === "z450") {
                packageSize = "450g Bag";
                sellingPrice = mtbRecordFields["Verkoop 450g (€/kg)"];
                weightGrams = 600;
            } else if (variantSuffix === "z1000") {
                packageSize = "1000g Bag";
                sellingPrice = mtbRecordFields["Verkoop 1kg (€/kg)"];
                weightGrams = 1250;
            } else if (variantSuffix === "nb175") {
                packageSize = "175g Jar";
                sellingPrice = mtbRecordFields["Nut Butter 175g (€/potje)"];
                weightGrams = 400;
            } else if (variantSuffix === "nb365") {
                packageSize = "365g Jar";
                sellingPrice = mtbRecordFields["Nut Butter 365g (€/pot)"];
                weightGrams = 750;
            }

            // *** FINAL FIX: Use option ID for Single Select fields where possible ***
            if (packageSize && selectOptions.packageSize?.has(packageSize)) {
                updates.packageSize = { id: selectOptions.packageSize.get(packageSize) };
            } else {
                updates.packageSize = packageSize; // Fallback for text fields
            }
            updates.sellingPrice = sellingPrice;
            updates.weightGrams = weightGrams;

            let productType = null;
            if (packageSize?.includes("Bag")) productType = "Nut Bag";
            else if (packageSize?.includes("Jar")) productType = "Nut Butter Jar";
            if(productType && selectOptions.productType?.has(productType)) {
                updates.productType = { id: selectOptions.productType.get(productType) };
            }

            let category = null;
            const baseProductGroupText = mtbRecordFields.baseProductGroup?.name?.toLowerCase() || '';
            if (productType === "Nut Butter Jar") category = "Nut Butters";
            else if (baseProductGroupText.includes("mix")) category = "Mixes";
            else category = "Whole Nuts";
            if(category && selectOptions.category?.has(category)) {
                updates.category = { id: selectOptions.category.get(category) };
            }

            // This is a linked record, not a single select. This needs a record ID.
            // For now, we assume it's not being updated by this script to avoid errors.
            // updates.baseProductGroup = ...; 

            const ingredientsText = mtbRecordFields.Ingredients || "";
            const allergenMatches = ingredientsText.match(/\b([A-Z][A-Z\s]+)\b/g) || [];
            updates.allergens = allergenMatches.map(allergen => {
                const name = (allergen.trim().toLowerCase()).replace(/^\w/, c => c.toUpperCase());
                return { name: name }; // Multi-select can create new options by name
            });

            updates.supplierProductName = mtbRecordFields.supplierProductName;
            updates.Ingredients = mtbRecordFields.Ingredients;
            updates.countryOfOrigin = mtbRecordFields.countryOfOrigin;
            updates.supplierProductUrl = mtbRecordFields.supplierProductUrl;
            updates.isOrganic = mtbRecordFields.isOrganic || false;
            updates.isRaw = mtbRecordFields.isRaw || false;
            updates.isGeroosterd = mtbRecordFields.isGeroosterd || false;
            updates.isGebrand = mtbRecordFields.isGebrand || false;
            updates.isSalted = mtbRecordFields.isSalted || false;
            updates.isNutbutterAvailable = mtbRecordFields.isNutbutterAvailable || false;
            updates.imageUrl = `/images/${sptId}.jpg`;
            updates.marketingName = internalName;
            
            updatePayloads.push({ id: sptRecord.id, fields: updates });
        }

        // --- Step 5: Send updates to Airtable in batches of 10 ---
        for (let i = 0; i < updatePayloads.length; i += 10) {
            const batch = updatePayloads.slice(i, i + 10);
            logDetails.push(`Updating batch of ${batch.length} records...`);

            const updateUrl = `${AIRTABLE_API_URL}/${AIRTABLE_BASE_ID}/${encodeURIComponent(sptTableName)}`;
            const updateResponse = await fetch(updateUrl, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ records: batch })
            });

            if (!updateResponse.ok) {
                const errorBody = await updateResponse.text();
                console.error("Airtable API Error:", errorBody);
                throw new Error(`Failed to update batch: ${errorBody}`);
            }
            
            logDetails.push(`Batch updated successfully.`);
            await delay(250);
        }

        return response.status(200).json({ 
            message: `Successfully processed and updated ${updatePayloads.length} records.`,
            details: logDetails
        });

    } catch (error) {
        console.error("An error occurred during the batch update:", error);
        logDetails.push(`ERROR: ${error.message}`);
        return response.status(500).json({ error: error.message, details: logDetails });
    }
}
// --- End of batch update handler ---
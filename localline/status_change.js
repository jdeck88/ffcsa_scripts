const fs = require('fs');
require('dotenv').config();
const utilities = require('./utilities');
const { isBecomeAMemberPriceList } = require('./subscription_price_lists');

function parseCsvLine(line) {
	const columns = [];
	let current = '';
	let quoted = false;

	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') {
			if (quoted && line[i + 1] === '"') {
				current += '"';
				i++;
			} else {
				quoted = !quoted;
			}
		} else if (char === ',' && !quoted) {
			columns.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	columns.push(current);
	return columns;
}

function normalizeHeader(column) {
	return String(column || '').replace(/^\uFEFF/, '').trim().toLowerCase();
}

function getColumnIndex(header, name) {
	return header.findIndex(column => normalizeHeader(column) === name);
}

function isBecomeAMemberColumns(columns, priceListIndex) {
	return priceListIndex >= 0 && isBecomeAMemberPriceList(columns[priceListIndex]);
}

function findStatusChanges(oldFilePath, newFilePath) {
	// Read old subscribers file
	const oldData = fs.readFileSync(oldFilePath, 'utf8');
	const oldLines = oldData.trim().split('\n');
	const oldHeader = parseCsvLine(oldLines[0]);

	// Find the index of 'status', 'email', and 'Plan #' columns in the old file
	const oldStatusIndex = getColumnIndex(oldHeader, 'status');
	const oldEmailIndex = getColumnIndex(oldHeader, 'email');
	const oldPlanIndex = getColumnIndex(oldHeader, 'plan #');
	const oldCustomerIndex = getColumnIndex(oldHeader, 'customer');
	const oldPriceListIndex = getColumnIndex(oldHeader, 'price list');

	// Read new subscribers file
	const newData = fs.readFileSync(newFilePath, 'utf8');
	const newLines = newData.trim().split('\n');
	const newHeader = parseCsvLine(newLines[0]);

	// Find the index of 'status', 'email', and 'Plan #' columns in the new file
	const newStatusIndex = getColumnIndex(newHeader, 'status');
	const newEmailIndex = getColumnIndex(newHeader, 'email');
	const newPlanIndex = getColumnIndex(newHeader, 'plan #');
	const newCustomerIndex = getColumnIndex(newHeader, 'customer');
	const newPriceListIndex = getColumnIndex(newHeader, 'price list');

	// Find status changes
	const cancelledCustomers = [];
	const newCustomers = [];
	const newPlans = [];

	for (let i = 1; i < oldLines.length; i++) {
		const oldColumns = parseCsvLine(oldLines[i]);
		if (!isBecomeAMemberColumns(oldColumns, oldPriceListIndex)) continue;
		const oldEmail = oldColumns[oldEmailIndex];
		const oldStatus = oldColumns[oldStatusIndex];
		const oldPlan = oldColumns[oldPlanIndex];
		const oldCustomer = oldColumns[oldCustomerIndex];

		const newLine = newLines.find(line => {
			const newColumns = parseCsvLine(line);
			if (!isBecomeAMemberColumns(newColumns, newPriceListIndex)) return false;
			const newEmail = newColumns[newEmailIndex];
			const newStatus = newColumns[newStatusIndex];
			const newPlan = newColumns[newPlanIndex];
			const newCustomer = newColumns[newCustomerIndex];
			return newEmail === oldEmail && newStatus !== oldStatus && newPlan === oldPlan;
		});

		if (newLine) {
			const newColumns = parseCsvLine(newLine);
			const newEmail = newColumns[newEmailIndex];
			const newStatus = newColumns[newStatusIndex];
			const newCustomer = newColumns[newCustomerIndex];
			if (newStatus.toLowerCase() === 'cancelled') {
				cancelledCustomers.push({ email: newEmail, plan: oldPlan, customer: newCustomer });
			} else if (newStatus.toLowerCase() === 'active') {
				newCustomers.push({ email: newEmail, plan: oldPlan, customer: newCustomer });
			}
		}
	}

	// Check for new plans
	for (let i = 1; i < newLines.length; i++) {
		const newColumns = parseCsvLine(newLines[i]);
		if (!isBecomeAMemberColumns(newColumns, newPriceListIndex)) continue;
		const newEmail = newColumns[newEmailIndex];
		const newPlan = newColumns[newPlanIndex];
		const newCustomer = newColumns[newCustomerIndex];

		const isNewPlan = !oldLines.some(oldLine => {
			const oldColumns = parseCsvLine(oldLine);
			if (!isBecomeAMemberColumns(oldColumns, oldPriceListIndex)) return false;
			const oldEmail = oldColumns[oldEmailIndex];
			const oldPlan = oldColumns[oldPlanIndex];
			return oldEmail === newEmail && oldPlan === newPlan;
		});

		if (isNewPlan) {
			newPlans.push({ email: newEmail, plan: newPlan, customer: newCustomer });
		}
	}

	return { cancelledCustomers, newPlans };
}

//const priorWeek = utilities.getPreviousWeek('2024-03-25'); // Date is formatted as "YYYY-MM-DD"
const priorWeek = utilities.getPreviousWeek(utilities.getToday()); // Date is formatted as "YYYY-MM-DD"
const { cancelledCustomers, newPlans } = findStatusChanges('data/subscribers_'+priorWeek.sundaystart+'.csv', 'data/subscribers_'+priorWeek.end+'.csv');

setTimeout(() => {
	subjectString =  'FFCSA Reports: New and Cancelled Plans ' + priorWeek.start + " to " + priorWeek.end;

	const cancelledCustomersText = cancelledCustomers.map(customer => `Email: ${customer.email}, Plan: ${customer.plan}, Customer: ${customer.customer}`).join('\n');
	const newPlansText = newPlans.map(plan => `Email: ${plan.email}, Plan: ${plan.plan}, Customer: ${plan.customer}`).join('\n');

	const textString = `
New plans:
	${newPlansText}

Cancelled plans:
	${cancelledCustomersText}
`;

	const emailOptions = {
		from: "jdeck88@gmail.com",
		to: "fullfarmcsa@deckfamilyfarm.com",
		cc: "jdeck88@gmail.com",
		subject: subjectString,
		text: textString
	};
	utilities.sendEmail(emailOptions)
}, 1000);

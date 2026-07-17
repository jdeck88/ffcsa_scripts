const BECOME_A_MEMBER_PRICE_LIST = 'Become a Member';
const BECOME_A_MEMBER_PRICE_LIST_ID = 2719;

function normalizePriceListName(value) {
  return String(value || '').trim().toLowerCase();
}

function isBecomeAMemberPriceList(value) {
  return normalizePriceListName(value) === normalizePriceListName(BECOME_A_MEMBER_PRICE_LIST);
}

function isBecomeAMemberSubscription(row) {
  return isBecomeAMemberPriceList(row && row['Price List']);
}

module.exports = {
  BECOME_A_MEMBER_PRICE_LIST,
  BECOME_A_MEMBER_PRICE_LIST_ID,
  isBecomeAMemberPriceList,
  isBecomeAMemberSubscription,
};

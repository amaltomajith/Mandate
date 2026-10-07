/**
 * The operator is whoever runs this deployment: the only person who may let a
 * merchant borrow the SERVER's own Razorpay and RazorpayX credentials.
 *
 * Sign-up is open, so without this any new account could press "use this
 * server's keys", add their own bank account as a payee, approve it themselves,
 * and have the Buying agent pay out of the operator's RazorpayX account. The list
 * is MANDATE_OPERATOR_EMAILS (comma-separated). Unset means nobody is an operator
 * and borrowing server keys is simply not offered, which is the right default for
 * a deployment with more than one merchant.
 */
export function isOperator(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = (process.env.MANDATE_OPERATOR_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}

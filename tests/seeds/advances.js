// People who can ask for a salary advance — a consultant, a salaried clerk, and a rider whose
// staff record hangs off his rider profile — plus an admin, a login with no pay profile, and a
// second company whose admin must not be able to touch any of it.
const bcrypt = require('bcryptjs');
const { TEST_PASSWORD } = require('../lib/harness');

module.exports = async function seed(prisma) {
  const pw = await bcrypt.hash(TEST_PASSWORD, 10);
  const company = await prisma.company.create({ data: { name: 'Test Co', slug: 'test-co', consultantPayDay: 11 } });
  const user = (username, role, companyId = company.id) => prisma.user.create({ data: { username, password: pw, name: username, role, companyId } });

  await user('boss', 'admin');

  const annieUser = await user('annie', 'consultant');
  const annie = await prisma.consultant.create({
    data: { name: 'Annie', payType: 'revenue_pct', commissionRate: 5, tierThreshold: 0, tierRate: 0, monthlyAllowance: 400,
            startDate: new Date('2020-01-01'), userId: annieUser.id, companyId: company.id },
  });

  const beaUser = await user('bea', 'inventory');
  const bea = await prisma.staff.create({
    data: { name: 'Beatrice', monthlySalary: 2500, startDate: new Date('2020-01-01'), userId: beaUser.id, companyId: company.id },
  });

  const riderUser = await user('musa', 'rider');
  const rider = await prisma.rider.create({ data: { name: 'Musa', phone: '0977000000', userId: riderUser.id, companyId: company.id } });
  const musa = await prisma.staff.create({ data: { name: 'Musa', monthlySalary: 1800, startDate: new Date('2020-01-01'), riderId: rider.id, companyId: company.id } });

  // A login nobody has linked to a pay profile yet.
  await user('loose', 'purchasing');

  const other = await prisma.company.create({ data: { name: 'Other Co', slug: 'other-co' } });
  await user('otherboss', 'admin', other.id);
  const otherClerk = await user('otherclerk', 'inventory', other.id);

  const looseUser = await prisma.user.findFirst({ where: { username: 'loose' } });
  const boss = await prisma.user.findFirst({ where: { username: 'boss' } });
  return { companyId: company.id, annieId: annie.id, beaId: bea.id, musaId: musa.id,
           looseUserId: looseUser.id, bossUserId: boss.id, annieUserId: annieUser.id, otherClerkUserId: otherClerk.id };
};

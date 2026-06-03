import { defineEntity, EntityClass, MikroORM, p, ref } from '@mikro-orm/core';
import { SqliteDriver } from '@mikro-orm/sqlite';

// Issue: https://github.com/mikro-orm/mikro-orm/issues/7843
// Full entity hierarchy copied from the actual project

// --- BaseEntity ---
const BaseEntitySchema = defineEntity({
  name: 'BaseEntity',
  abstract: true,
  properties: {
    id: p.integer().primary().autoincrement(),
  },
});
class BaseEntity extends BaseEntitySchema.class {}
BaseEntitySchema.setClass(BaseEntity);

// --- ExtendBaseEntity (with self-referencing createUserId/updateUserId via string ref) ---
// String reference to break circular ESM dependency (same pattern as in the project)
const userEntityRef = 'UserEntity' as unknown as EntityClass<UserEntity>;

const ExtendBaseEntitySchema = defineEntity({
  name: 'ExtendBaseEntity',
  abstract: true,
  extends: BaseEntitySchema,
  properties: {
    createTime: p.bigint('number').defaultRaw('(unixepoch() * 1000)').fieldName('createTime'),
    createUserId: () =>
      p.manyToOne(userEntityRef).nullable().fieldName('createUserId').ref().deleteRule('set null').updateRule('cascade'),
    updateTime: p
      .bigint('number')
      .nullable()
      .onUpdate((): number => Date.now())
      .fieldName('updateTime'),
    updateUserId: () =>
      p
        .manyToOne(userEntityRef)
        .nullable()
        .fieldName('updateUserId')
        .ref()
        .deleteRule('set null')
        .updateRule('cascade'),
  },
});
class ExtendBaseEntity extends ExtendBaseEntitySchema.class {}
ExtendBaseEntitySchema.setClass(ExtendBaseEntity);

// --- RuleGroup ---
const RuleGroupSchema = defineEntity({
  name: 'RuleGroupEntity',
  tableName: 'rule_groups',
  extends: ExtendBaseEntitySchema,
  properties: {
    name: p.string().unique().fieldName('name'),
    isFrontAccess: p.boolean().default(false).fieldName('isFrontAccess'),
    isPortalAccess: p.boolean().default(false).fieldName('isPortalAccess'),
  },
});
class RuleGroup extends RuleGroupSchema.class {}
RuleGroupSchema.setClass(RuleGroup);

// --- UserEntity ---
const UserEntitySchema = defineEntity({
  name: 'UserEntity',
  tableName: 'users',
  extends: ExtendBaseEntitySchema,
  properties: {
    login: p.string().length(255),
    ruleGroupId: () =>
      p
        .manyToOne(RuleGroup)
        .ref()
        .fieldName('ruleGroupId')
        .nullable()
        .deleteRule('set null')
        .updateRule('cascade'),
  },
});
class UserEntity extends UserEntitySchema.class {}
UserEntitySchema.setClass(UserEntity);

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ':memory:',
    entities: [RuleGroup, UserEntity],
    debug: ['query', 'query-params'],
    allowGlobalContext: true,
    disableIdentityMap: true,
  });
  await orm.schema.refresh();
});

afterAll(async () => {
  await orm.close(true);
});

test('dirty tracking detects manyToOne Ref change with full entity hierarchy', async () => {
  // Setup: system user + ruleGroup + admin user (ruleGroupId = null)
  const systemUser = orm.em.create(UserEntity, { login: 'system', createUserId: null, ruleGroupId: null });
  const ruleGroup = orm.em.create(RuleGroup, { name: 'admin', createUserId: ref(systemUser) });
  orm.em.create(UserEntity, { login: 'admin', createUserId: ref(systemUser), ruleGroupId: null });
  await orm.em.flush();

  // Simulate seeder: nativeUpdate on RuleGroup BEFORE assigning Ref on User
  // (in the real seeder, nativeUpdate is called when ruleGroup already exists in DB)
  await orm.em.nativeUpdate(
    RuleGroup,
    { id: ruleGroup.id },
    { isFrontAccess: true, isPortalAccess: true, updateUserId: systemUser.id, updateTime: Date.now() },
  );

  // Act: load admin user and assign ruleGroupId (all entities still managed in same EM)
  const adminUser = await orm.em.findOneOrFail(UserEntity, { login: 'admin' });
  adminUser.ruleGroupId = ref(ruleGroup);
  adminUser.updateUserId = ref(systemUser);
  await orm.em.flush(); // should generate UPDATE
  orm.em.clear();

  // Assert
  const reloaded = await orm.em.findOneOrFail(UserEntity, { login: 'admin' });
  expect(reloaded.ruleGroupId).not.toBeNull();
  expect(reloaded.updateUserId).not.toBeNull();
});

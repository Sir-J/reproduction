import { defineEntity, MikroORM, p, ref } from '@mikro-orm/core';
import { SqliteDriver } from '@mikro-orm/sqlite';

// Issue: https://github.com/mikro-orm/mikro-orm/issues/7843
// defineEntity API: dirty tracking doesn't detect changes to manyToOne Ref fields

const CategorySchema = defineEntity({
  name: 'Category',
  tableName: 'categories',
  properties: {
    id: p.integer().primary().autoincrement(),
    name: p.string(),
  },
});

class Category extends CategorySchema.class {}
CategorySchema.setClass(Category);

const ItemSchema = defineEntity({
  name: 'Item',
  tableName: 'items',
  properties: {
    id: p.integer().primary().autoincrement(),
    title: p.string(),
    categoryId: () =>
      p.manyToOne(Category).ref().fieldName('categoryId').nullable(),
  },
});

class Item extends ItemSchema.class {}
ItemSchema.setClass(Item);

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ':memory:',
    entities: [Category, Item],
    debug: ['query', 'query-params'],
    allowGlobalContext: true,
  });
  await orm.schema.refreshDatabase();
});

afterAll(async () => {
  await orm.close(true);
});

test('dirty tracking detects changes to manyToOne Ref fields defined via defineEntity', async () => {
  // Setup: item with no category
  const category = orm.em.create(Category, { name: 'electronics' });
  orm.em.create(Item, { title: 'phone', categoryId: null });
  await orm.em.flush();
  orm.em.clear();

  // Act: assign category to item via Ref field
  const item = await orm.em.findOneOrFail(Item, { title: 'phone' });
  item.categoryId = ref(category); // change from null → Ref
  await orm.em.flush(); // expected: UPDATE items SET categoryId = 1 WHERE id = 1
  orm.em.clear();

  // Assert: change must be persisted
  const reloaded = await orm.em.findOneOrFail(Item, { title: 'phone' });
  expect(reloaded.categoryId).not.toBeNull();
});

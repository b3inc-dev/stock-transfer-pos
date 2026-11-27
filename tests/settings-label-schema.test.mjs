import assert from 'node:assert/strict';
import {test} from 'node:test';
const parent=process.env.POS_SETTINGS_SCHEMA_PARENT==='1';
const {SettingsV1Schema,parseSettings}=await import(parent?'../app/utils/__audit_parent_schemas.ts':'../app/utils/schemas.ts');
for(const [section,field] of [['order','desiredDeliveryQuickDayLabels'],['outbound','arrivalQuickDayLabels']]){
 test(section+' quick-day labels preserve valid persisted settings and reject non-string values without throwing',()=>{
  const labels={'1':'翌日','2':'2日後','30':'1ヶ月後'};
  const payload={version:1,carriers:[],visibleLocationIds:['synthetic-location'],[section]:{[field]:labels}};
  const parsed=SettingsV1Schema.safeParse(payload);
  assert.equal(parsed.success,true);
  assert.deepEqual(parsed.data[section][field],labels);
  assert.deepEqual(parseSettings(JSON.stringify(payload)),payload,'valid settings must not silently reset to defaults');
  for(const value of [2,null,{},['label']]){
   const invalid=SettingsV1Schema.safeParse({...payload,[section]:{[field]:{'2':value}}});
   assert.equal(invalid.success,false,'the existing string-label contract must reject non-string values');
  }
 });
}
test('missing or empty quick-day label maps retain existing settings defaults',()=>{
 for(const payload of [{version:1},{version:1,order:{desiredDeliveryQuickDayLabels:{}}},{version:1,outbound:{arrivalQuickDayLabels:{}}}]){
  const parsed=SettingsV1Schema.safeParse(payload);assert.equal(parsed.success,true);
  assert.deepEqual(parsed.data,{carriers:[],...payload});
 }
});

using Aspose.Tasks;
using Aspose.Tasks.Saving;
using System.Text;

Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
var license = Environment.GetEnvironmentVariable("ASPOSE_TASKS_LICENSE");
if (string.IsNullOrEmpty(license)) throw new Exception("Set ASPOSE_TASKS_LICENSE to run real MPP regression tests");
new License().SetLicense(license);
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
var project = new Project(args[0]);
var cost = project.ExtendedAttributes.Single(d => d.Alias == "支出金额（元）");
Check(cost.CfType == CustomFieldType.Cost, "普通金额应使用原生成本字段");
Check(project.ExtendedAttributes.Single(d => d.Alias == "大额预算（元）").CfType == CustomFieldType.Text, "大金额使用文本以保留精度");
Check(project.ExtendedAttributes.Single(d => d.Alias == "精确数量（台）").CfType == CustomFieldType.Text, "高精度数值使用文本");
Check(project.Tables.Any(t => t.TableFields.Any(f => ((int)f.Field).ToString() == cost.FieldId)), "导出的任务表应显示自定义金额列");
var task = project.RootTask.Children.First(t => t.Get(Tsk.WBS) == "采购-31");
Check(task.Get(Tsk.Duration).TimeUnit == TimeUnitType.Day, "日级任务以天显示工期");
Check(task.Get(Tsk.Duration).TimeSpan.TotalMinutes == 7200, "五天等于7200分钟");
var value = task.ExtendedAttributes.Single(a => a.FieldId.ToString() == cost.FieldId);
value.NumericValue = 234.56m;
project.Save(args[1], SaveFileFormat.Mpp);

// A native Project document with no TrackingGantt metadata: import by native
// field definitions, not by our own export envelope.
var native = new Project { CalculationMode = CalculationMode.Manual };
var nativeCost = ExtendedAttributeDefinition.CreateTaskDefinition(ExtendedAttributeTask.Cost1, "外部金额");
var nativeText = ExtendedAttributeDefinition.CreateTaskDefinition(ExtendedAttributeTask.Text1, "合同编号");
var nativeFlag = ExtendedAttributeDefinition.CreateTaskDefinition(ExtendedAttributeTask.Flag1, "已验收");
var nativeDate = ExtendedAttributeDefinition.CreateTaskDefinition(ExtendedAttributeTask.Date1, "外部付款日期");
foreach (var field in new[] { nativeCost, nativeText, nativeFlag, nativeDate }) native.ExtendedAttributes.Add(field);
var external = native.RootTask.Children.Add("外部文件任务");
external.Set(Tsk.WBS, "外部-51");
external.ExtendedAttributes.Add(nativeCost.CreateExtendedAttribute(321.09m));
external.ExtendedAttributes.Add(nativeText.CreateExtendedAttribute("000123"));
external.ExtendedAttributes.Add(nativeFlag.CreateExtendedAttribute(false));
external.ExtendedAttributes.Add(nativeDate.CreateExtendedAttribute(new DateTime(2026, 11, 7)));
native.Save(args[2], SaveFileFormat.Mpp);
Console.WriteLine("PASS native Project fields, visible columns, days, external edits and native-only fixture");

using System.Globalization;
using System.Text;
using System.Text.Json;
using Aspose.Tasks;

namespace AsposeTasksCli;

internal static partial class Program
{
    private const string MetadataProperty = "TrackingGantt.CustomFields.v1";
    private sealed class CustomFieldDto
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public string Type { get; set; } = "text";
        public string? Unit { get; set; }
        public List<string>? Options { get; set; }
        public bool Archived { get; set; }
    }
    private sealed class FieldMapping
    {
        public CustomFieldDto Field { get; set; } = new();
        public string NativeFieldId { get; set; } = "";
        [System.Text.Json.Serialization.JsonIgnore] public bool IsFlag { get; set; }
    }
    private sealed class FileMetadata
    {
        public int Version { get; set; } = 1;
        public List<FieldMapping> Fields { get; set; } = new();
        public string? TimeGranularity { get; set; }
        public List<ProjectLineOut>? ProjectLines { get; set; }
        public List<DepOut> InactiveDependencies { get; set; } = new();
    }
    private static string FieldAlias(CustomFieldDto f) => f.Name + (string.IsNullOrEmpty(f.Unit) ? "" : $"（{f.Unit}）") + (f.Archived ? "（已停用）" : "");

    private static void WriteMetadata(Project project, FileMetadata metadata)
    {
        // MPP document properties may use an ANSI code page. Base64 keeps all
        // Chinese names/options intact without consuming a task text field.
        var encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(metadata, JsonOpts)));
        project.CustomProps.Add(MetadataProperty, encoded);
    }
    private static FileMetadata? ReadMetadata(Project project)
    {
        if (!project.CustomProps.Contains(MetadataProperty)) return null;
        try {
            var encoded = project.CustomProps[MetadataProperty].Value?.ToString() ?? "";
            if (encoded.Length > 8 * 1024 * 1024) throw new InvalidDataException("属性配置过大");
            var metadata = JsonSerializer.Deserialize<FileMetadata>(Convert.FromBase64String(encoded), JsonOpts);
            if (metadata?.Version != 1 || metadata.Fields.Count > 100) throw new InvalidDataException("属性配置版本无效");
            return metadata;
        } catch (Exception ex) { throw new InvalidDataException($"Project 中的任务属性配置损坏，未导入任何数据：{ex.Message}"); }
    }

    private static List<FieldMapping> WriteCustomFields(Project project, ExportInput input, Dictionary<string, Aspose.Tasks.Task> tasks)
    {
        var used = new HashSet<string>();
        var result = new List<FieldMapping>();
        int lookupId = 1;
        foreach (var field in input.CustomFields) {
            var values = input.Tasks.Select(t => t.CustomValues.GetValueOrDefault(field.Id, "")).Where(v => v.Length > 0).ToList();
            var kind = field.Type switch { "money" => "Cost", "number" => "Number", "date" => "Date", _ => "Text" };
            // Project desktop numeric fields have tighter limits than this app.
            // Use a visible text column when a native numeric/date field would
            // lose precision; the original application type is kept in metadata.
            if (kind == "Cost" && values.Any(v => !decimal.TryParse(v, NumberStyles.Number, CultureInfo.InvariantCulture, out var n) || Math.Abs(n) > 999999999999.99m)) kind = "Text";
            if (kind == "Number" && values.Any(v => !decimal.TryParse(v, NumberStyles.Number, CultureInfo.InvariantCulture, out var n) || Math.Abs(n) > 9999999999999.99m || decimal.Round(n, 2) != n)) kind = "Text";
            if (kind == "Date" && values.Any(v => !DateTime.TryParse(v, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) || d.Year < 1984 || d.Year > 2149)) kind = "Text";
            var limit = kind == "Text" ? 30 : kind == "Number" ? 20 : 10;
            var slot = Enumerable.Range(1, limit).Select(i => kind + i).FirstOrDefault(n => !used.Contains(n));
            if (slot == null && kind != "Text") { kind = "Text"; slot = Enumerable.Range(1, 30).Select(i => "Text" + i).FirstOrDefault(n => !used.Contains(n)); }
            if (slot == null) throw new InvalidDataException($"属性「{field.Name}」没有可用的 Project 自定义字段，请减少属性数量或使用 Excel 导出；没有省略任何属性");
            if (kind == "Text" && values.Any(v => v.Length > 255)) throw new InvalidDataException($"属性「{field.Name}」有超过 Project 文本字段 255 字符限制的内容，请使用 Excel 导出或缩短内容");
            used.Add(slot);
            var nativeId = Enum.Parse<ExtendedAttributeTask>(slot);
            var definition = field.Type == "select"
                ? ExtendedAttributeDefinition.CreateLookupTaskDefinition(nativeId, FieldAlias(field))
                : ExtendedAttributeDefinition.CreateTaskDefinition(nativeId, FieldAlias(field));
            if (field.Type == "select") {
                foreach (var option in field.Options ?? new()) definition.AddLookupValue(new Value { Id = lookupId++, StringValue = option });
                definition.RestrictValues = true;
            }
            project.ExtendedAttributes.Add(definition);
            result.Add(new FieldMapping { Field = field, NativeFieldId = definition.FieldId });
            foreach (var task in input.Tasks) {
                var value = task.CustomValues.GetValueOrDefault(field.Id, "");
                if (value.Length == 0) continue; // Explicit 0 still creates an attribute; blank does not.
                ExtendedAttribute attribute;
                if (field.Type == "select") attribute = definition.CreateExtendedAttribute(definition.ValueList.First(v => v.StringValue == value));
                else if (kind == "Cost" || kind == "Number") attribute = definition.CreateExtendedAttribute(decimal.Parse(value, CultureInfo.InvariantCulture));
                else if (kind == "Date") attribute = definition.CreateExtendedAttribute(DateTime.ParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture));
                else attribute = definition.CreateExtendedAttribute(value);
                tasks[task.TaskCode].ExtendedAttributes.Add(attribute);
            }
            // Include each attribute in task tables, so it is visible on opening
            // the exported Project file rather than requiring manual insertion.
            foreach (var table in project.Tables.Where(t => t.TableType == ItemType.TaskItem).Append(project.DefaultView.Table).Distinct()) {
                table.TableFields.Add(new TableField { Field = (Field)int.Parse(definition.FieldId, CultureInfo.InvariantCulture), Title = FieldAlias(field), Width = 18 });
            }
        }
        return result;
    }

    private static List<FieldMapping> ReadCustomFields(Project project, List<Aspose.Tasks.Task> tasks, FileMetadata? metadata)
    {
        var definitions = project.ExtendedAttributes.Where(d => d.ElementType == ElementType.Task).ToDictionary(d => d.FieldId);
        var result = new List<FieldMapping>();
        foreach (var original in metadata?.Fields ?? new()) {
            if (!definitions.TryGetValue(original.NativeFieldId, out var definition)) continue;
            original.IsFlag = definition.CfType == CustomFieldType.Flag;
            var field = original.Field;
            if (!string.IsNullOrWhiteSpace(definition.Alias) && definition.Alias != FieldAlias(field)) {
                var suffix = (string.IsNullOrEmpty(field.Unit) ? "" : $"（{field.Unit}）") + (field.Archived ? "（已停用）" : "");
                field.Name = suffix.Length > 0 && definition.Alias.EndsWith(suffix, StringComparison.Ordinal) ? definition.Alias[..^suffix.Length] : definition.Alias;
            }
            if (field.Type == "select") field.Options = (field.Options ?? new()).Concat(definition.ValueList.Select(v => v.StringValue).Where(v => v != null)).Distinct().ToList()!;
            result.Add(original);
        }
        foreach (var definition in definitions.Values) {
            if (result.Any(m => m.NativeFieldId == definition.FieldId)) continue;
            var name = string.IsNullOrWhiteSpace(definition.Alias) ? definition.FieldName : definition.Alias;
            var kind = definition.CfType;
            var type = kind switch { CustomFieldType.Cost => "money", CustomFieldType.Number or CustomFieldType.Duration => "number", CustomFieldType.Date or CustomFieldType.Start or CustomFieldType.Finish => "date", CustomFieldType.Flag => "select", _ => "text" };
            var attributes = tasks.SelectMany(t => t.ExtendedAttributes).Where(a => a.FieldId.ToString(CultureInfo.InvariantCulture) == definition.FieldId).ToList();
            if (type == "date" && attributes.Any(a => a.DateValue.TimeOfDay != TimeSpan.Zero && ToDateTimeString(a.DateValue) != null)) type = "text";
            var options = kind == CustomFieldType.Flag ? new List<string> { "是", "否" } : definition.ValueList.Select(v => v.StringValue).Where(v => !string.IsNullOrEmpty(v)).Distinct().ToList();
            if (kind == CustomFieldType.Text && options.Count > 0) type = "select";
            if (result.Any(f => f.Field.Name == name)) name += $"（{definition.FieldName}）";
            var field = new CustomFieldDto { Id = Guid.NewGuid().ToString(), Name = name, Type = type, Options = type == "select" ? options! : null,
                Unit = kind == CustomFieldType.Duration ? "分钟" : null };
            result.Add(new FieldMapping { Field = field, NativeFieldId = definition.FieldId, IsFlag = kind == CustomFieldType.Flag });
        }
        // Project permits new lookup values. Include actual text values as well
        // as its lookup table so editing the MPP does not make import fail.
        foreach (var mapping in result.Where(m => m.Field.Type == "select")) {
            var actual = tasks.Select(t => ReadNativeValue(t, mapping)).Where(v => !string.IsNullOrEmpty(v));
            mapping.Field.Options = (mapping.Field.Options ?? new()).Concat(actual).Distinct().ToList();
        }
        return result;
    }

    private static string ReadNativeValue(Aspose.Tasks.Task task, FieldMapping mapping)
    {
        var attribute = task.ExtendedAttributes.FirstOrDefault(a => a.FieldId.ToString(CultureInfo.InvariantCulture) == mapping.NativeFieldId);
        // Native Project flags are boolean and default to No; MPP may omit the
        // stored attribute for false. Other field types retain an empty value.
        if (attribute == null) return mapping.IsFlag ? "否" : "";
        var lookup = !Guid.TryParse(attribute.ValueGuid, out var valueGuid) ? null : attribute.AttributeDefinition.ValueList.FirstOrDefault(v => v.ValueGuid == valueGuid);
        var kind = attribute.AttributeDefinition.CfType;
        if (kind == CustomFieldType.Cost) return (lookup?.NumericValue ?? attribute.NumericValue).ToString("0.00", CultureInfo.InvariantCulture);
        if (kind == CustomFieldType.Number) return (lookup?.NumericValue ?? attribute.NumericValue).ToString("0.############################", CultureInfo.InvariantCulture);
        if (kind == CustomFieldType.Flag) return attribute.FlagValue ? "是" : "否";
        if (kind == CustomFieldType.Duration) return attribute.DurationValue.TimeSpan.TotalMinutes.ToString("0.########", CultureInfo.InvariantCulture);
        if (kind is CustomFieldType.Date or CustomFieldType.Start or CustomFieldType.Finish) {
            var date = lookup?.DateTimeValue ?? attribute.DateValue;
            var formatted = ToDateTimeString(date) ?? "";
            return mapping.Field.Type == "date" && formatted.Length >= 10 ? formatted[..10] : formatted;
        }
        return lookup?.StringValue ?? attribute.TextValue ?? "";
    }
    private static Dictionary<string, string> ReadCustomValues(Aspose.Tasks.Task task, List<FieldMapping> mappings) => mappings.ToDictionary(m => m.Field.Id, m => ReadNativeValue(task, m));

    private static void VerifyCustomFieldRoundtrip(string file, ExportInput input)
    {
        var project = new Project(file);
        var tasks = new List<Aspose.Tasks.Task>(); CollectTasks(project.RootTask, tasks);
        var metadata = ReadMetadata(project) ?? throw new InvalidDataException("Project 未能保存属性配置，已停止导出");
        var fields = ReadCustomFields(project, tasks, metadata);
        if (fields.Count != input.CustomFields.Count) throw new InvalidDataException("Project 属性数量校验失败，已停止导出");
        foreach (var original in input.Tasks) {
            var task = tasks.FirstOrDefault(t => TaskCode(t) == original.TaskCode) ?? throw new InvalidDataException($"Project 中找不到任务「{original.Name}」，已停止导出");
            var values = ReadCustomValues(task, fields);
            foreach (var field in input.CustomFields) {
                if (values.GetValueOrDefault(field.Id, "") != original.CustomValues.GetValueOrDefault(field.Id, ""))
                    throw new InvalidDataException($"Project 无法完整保存任务「{original.Name}」的「{field.Name}」，请使用 Excel 导出；未输出有损文件");
            }
        }
    }
}

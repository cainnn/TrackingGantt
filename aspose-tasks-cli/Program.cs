using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Aspose.Tasks;
using Aspose.Tasks.Saving;

namespace AsposeTasksCli;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        WriteIndented = false,
    };

    private static int Main(string[] args)
    {
        try
        {
            // Aspose.Tasks 写 MPP 时可能依赖 legacy 编码（如 936 GBK 中文）。
            // 默认 .NET Core 只支持 UTF-* 系列，需手动注册 CodePages provider。
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

            LoadLicense();

            if (args.Length == 0)
            {
                WriteError("usage: aspose-tasks-cli <import|export> <args...>");
                return 2;
            }

            return args[0] switch
            {
                "import" => RunImport(args),
                "export" => RunExport(args),
                _ => Fail($"unknown command: {args[0]}"),
            };
        }
        catch (Exception ex)
        {
            WriteError($"FATAL: {ex.GetType().Name}: {ex.Message}");
            return 1;
        }
    }

    // ───────────────────────────── License ─────────────────────────────
    private static void LoadLicense()
    {
        var licPath = Environment.GetEnvironmentVariable("ASPOSE_TASKS_LICENSE")
                      ?? "/Users/acai/AsposeLicense/Aspose.Total.lic";
        if (!File.Exists(licPath))
        {
            WriteError($"WARN: license not found at {licPath}, running in evaluation mode");
            return;
        }
        try
        {
            var lic = new License();
            lic.SetLicense(licPath);
        }
        catch (Exception ex)
        {
            WriteError($"WARN: failed to apply license: {ex.Message}");
        }
    }

    // ───────────────────────────── IMPORT ─────────────────────────────
    private static int RunImport(string[] args)
    {
        if (args.Length < 2) return Fail("usage: import <input.mpp>");
        var input = args[1];
        if (!File.Exists(input)) return Fail($"file not found: {input}");

        var project = new Project(input);

        var tasks = new List<TaskOut>();
        var deps = new List<DepOut>();
        var lines = new List<ProjectLineOut>();

        var rootTask = project.RootTask;
        var allTasks = new List<Aspose.Tasks.Task>();
        CollectTasks(rootTask, allTasks);

        var parentMap = BuildParentMap(rootTask);
        var seen = new HashSet<int>();

        foreach (var t in allTasks)
        {
            if (t == rootTask) continue;
            if (!seen.Add(t.Get(Tsk.Id))) continue;

            var code = TaskCode(t);
            var parentCode = parentMap.TryGetValue(t.Get(Tsk.Id), out var pCode) ? pCode : "";

            var startDate = t.Get(Tsk.Start);
            var finishDate = t.Get(Tsk.Finish);

            tasks.Add(new TaskOut
            {
                TaskCode = code,
                Level = ComputeLevel(t),
                ParentTaskCode = parentCode,
                Name = t.Get(Tsk.Name) ?? "",
                Assignee = JoinAssignees(t),
                StartDate = ToYmd(startDate),
                EndDate = ToYmd(finishDate),
                Duration = DurationToDays(t),
                IsMilestone = t.Get(Tsk.IsMilestone),
                AutoSchedule = !t.Get(Tsk.IsManual),
                Note = NullIfEmpty(t.Get(Tsk.NotesText)),
                PercentDone = t.Get(Tsk.PercentComplete),
                ConstraintType = MapConstraintType(t.Get(Tsk.ConstraintType)),
                ConstraintDate = ToYmd(t.Get(Tsk.ConstraintDate)),
                Rollup = t.Get(Tsk.IsRollup),
                Inactive = !t.Get(Tsk.IsActive),
                ProjectBoundary = "ask",
                Status = MapStatus(t),
                Deadline = ToYmd(t.Get(Tsk.Deadline)),
                BaselineEndDate = null,
            });
        }

        foreach (var link in project.TaskLinks)
        {
            var fromCode = TaskCode(link.PredTask);
            var toCode = TaskCode(link.SuccTask);
            if (string.IsNullOrEmpty(fromCode) || string.IsNullOrEmpty(toCode)) continue;

            int type = link.LinkType switch
            {
                TaskLinkType.StartToStart => 0,
                TaskLinkType.StartToFinish => 1,
                TaskLinkType.FinishToStart => 2,
                TaskLinkType.FinishToFinish => 3,
                _ => 2,
            };

            int lag = 0;
            try
            {
                // LinkLagTimeSpan is a TimeSpan (depends on LagFormat)
                lag = (int)Math.Round(link.LinkLagTimeSpan.TotalDays);
            }
            catch { /* keep 0 */ }

            deps.Add(new DepOut
            {
                FromTaskCode = fromCode,
                ToTaskCode = toCode,
                Type = type,
                Lag = lag,
                Active = true,
            });
        }

        var statusDate = ToYmd(project.Get(Prj.StatusDate));
        if (statusDate == "1984-01-01") statusDate = null;

        var result = new ImportResult
        {
            Tasks = tasks,
            Dependencies = deps,
            StatusDate = statusDate,
            ProjectLines = lines.Count == 0 ? null : lines,
        };

        Console.Out.Write(JsonSerializer.Serialize(result, JsonOpts));
        Console.Out.Flush();
        return 0;
    }

    private static void CollectTasks(Aspose.Tasks.Task parent, List<Aspose.Tasks.Task> result)
    {
        foreach (Aspose.Tasks.Task t in parent.Children)
        {
            result.Add(t);
            if (t.Children != null && t.Children.Count > 0)
                CollectTasks(t, result);
        }
    }

    private static Dictionary<int, string> BuildParentMap(Aspose.Tasks.Task root)
    {
        var map = new Dictionary<int, string>();
        void Walk(Aspose.Tasks.Task node, bool isRoot)
        {
            foreach (Aspose.Tasks.Task child in node.Children)
            {
                map[child.Get(Tsk.Id)] = isRoot ? "" : TaskCode(node, root);
                if (child.Children != null && child.Children.Count > 0) Walk(child, false);
            }
        }
        Walk(root, true);
        return map;
    }

    private static int ComputeLevel(Aspose.Tasks.Task t)
    {
        // Aspose.Tasks exposes OutlineLevel directly (1-based).
        try { return t.Get(Tsk.OutlineLevel); } catch { return 1; }
    }

    private static string TaskCode(Aspose.Tasks.Task t, Aspose.Tasks.Task root)
    {
        if (t == null || t == root) return "";
        var wbs = t.Get(Tsk.WBS);
        if (!string.IsNullOrWhiteSpace(wbs)) return wbs;
        var id = t.Get(Tsk.Id);
        return id.ToString(CultureInfo.InvariantCulture);
    }

    private static string TaskCode(Aspose.Tasks.Task t)
    {
        if (t == null) return "";
        var wbs = t.Get(Tsk.WBS);
        if (!string.IsNullOrWhiteSpace(wbs)) return wbs;
        var id = t.Get(Tsk.Id);
        return id.ToString(CultureInfo.InvariantCulture);
    }

    private static string? JoinAssignees(Aspose.Tasks.Task t)
    {
        try
        {
            var names = new List<string>();
            foreach (ResourceAssignment ra in t.Assignments)
            {
                var r = ra.Resource;
                if (r == null) continue;
                var n = r.Get(Rsc.Name);
                if (!string.IsNullOrWhiteSpace(n)) names.Add(n);
            }
            return names.Count == 0 ? null : string.Join(",", names);
        }
        catch { return null; }
    }

    private static int? DurationToDays(Aspose.Tasks.Task t)
    {
        try
        {
            var d = t.Get(Tsk.Duration);
            if (d == null) return null;
            // Aspose Duration → TimeSpan days, rounded
            var days = d.TimeSpan.TotalDays;
            if (double.IsNaN(days) || double.IsInfinity(days)) return null;
            return (int)Math.Round(days);
        }
        catch { return null; }
    }

    private static string MapConstraintType(ConstraintType ct) => ct switch
    {
        ConstraintType.AsSoonAsPossible => "asap",
        ConstraintType.AsLateAsPossible => "alap",
        ConstraintType.MustStartOn => "muststarton",
        ConstraintType.MustFinishOn => "mustfinishon",
        ConstraintType.StartNoEarlierThan => "startnoearlierthan",
        ConstraintType.StartNoLaterThan => "startnolaterthan",
        ConstraintType.FinishNoEarlierThan => "finishnoearlierthan",
        ConstraintType.FinishNoLaterThan => "finishnolaterthan",
        _ => "asap",
    };

    private static string? MapStatus(Aspose.Tasks.Task t)
    {
        var pct = t.Get(Tsk.PercentComplete);
        if (pct >= 100) return "completed";
        if (pct > 0) return "started";
        return "notstarted";
    }

    // ───────────────────────────── EXPORT ─────────────────────────────
    private static int RunExport(string[] args)
    {
        if (args.Length < 3) return Fail("usage: export <input.json> <output.mpp>");
        var inputJson = args[1];
        var outputMpp = args[2];

        ExportInput payload;
        using (var fs = File.OpenRead(inputJson))
        {
            payload = JsonSerializer.Deserialize<ExportInput>(fs, JsonOpts)
                      ?? throw new InvalidOperationException("empty export payload");
        }

        var project = new Project();
        project.Set(Prj.Name, payload.Name ?? "Project");
        if (!string.IsNullOrEmpty(payload.StartDate)) project.Set(Prj.StartDate, ParseYmd(payload.StartDate)!.Value);
        if (!string.IsNullOrEmpty(payload.StatusDate)) project.Set(Prj.StatusDate, ParseYmd(payload.StatusDate)!.Value);

        // 排序：保持父任务在子任务之前
        var byCode = new Dictionary<string, Aspose.Tasks.Task>();
        var orderedRoots = payload.Tasks
            .Where(t => string.IsNullOrEmpty(t.ParentTaskCode))
            .OrderBy(t => t.OrderIndex);

        foreach (var root in orderedRoots)
            AddTaskRecursive(project.RootTask, root, payload.Tasks, byCode);

        foreach (var dep in payload.Dependencies)
        {
            if (!byCode.TryGetValue(dep.FromTaskCode, out var from)) continue;
            if (!byCode.TryGetValue(dep.ToTaskCode, out var to)) continue;
            var linkType = dep.Type switch
            {
                0 => TaskLinkType.StartToStart,
                1 => TaskLinkType.StartToFinish,
                2 => TaskLinkType.FinishToStart,
                3 => TaskLinkType.FinishToFinish,
                _ => TaskLinkType.FinishToStart,
            };
            var link = project.TaskLinks.Add(from, to, linkType);
            if (dep.Lag != 0)
            {
                link.LinkLagTimeSpan = TimeSpan.FromDays(dep.Lag);
            }
        }

        project.Save(outputMpp, SaveFileFormat.Mpp);
        return 0;
    }

    private static void AddTaskRecursive(
        Aspose.Tasks.Task parent,
        TaskIn t,
        List<TaskIn> all,
        Dictionary<string, Aspose.Tasks.Task> byCode)
    {
        var node = parent.Children.Add(t.Name ?? t.TaskCode);
        byCode[t.TaskCode] = node;

        if (t.IsMilestone) node.Set(Tsk.IsMilestone, true);
        if (!t.AutoSchedule) node.Set(Tsk.IsManual, true);
        if (t.Inactive) node.Set(Tsk.IsActive, false);
        if (t.Rollup) node.Set(Tsk.IsRollup, true);

        var start = ParseYmd(t.StartDate);
        var end = ParseYmd(t.EndDate);
        if (start.HasValue) node.Set(Tsk.Start, start.Value);
        if (end.HasValue) node.Set(Tsk.Finish, end.Value);

        if (t.Duration.HasValue)
        {
            var dur = node.ParentProject.GetDuration(t.Duration.Value, TimeUnitType.Day);
            node.Set(Tsk.Duration, dur);
        }

        if (t.PercentDone.HasValue)
            node.Set(Tsk.PercentComplete, t.PercentDone.Value);

        if (!string.IsNullOrEmpty(t.Note))
            node.Set(Tsk.NotesText, t.Note);

        var ct = MapConstraintTypeOut(t.ConstraintType);
        if (ct.HasValue) node.Set(Tsk.ConstraintType, ct.Value);
        var cd = ParseYmd(t.ConstraintDate);
        if (cd.HasValue) node.Set(Tsk.ConstraintDate, cd.Value);

        var deadline = ParseYmd(t.Deadline);
        if (deadline.HasValue) node.Set(Tsk.Deadline, deadline.Value);

        var children = all
            .Where(c => c.ParentTaskCode == t.TaskCode)
            .OrderBy(c => c.OrderIndex);
        foreach (var child in children)
            AddTaskRecursive(node, child, all, byCode);
    }

    private static ConstraintType? MapConstraintTypeOut(string? s) => s switch
    {
        "asap" => ConstraintType.AsSoonAsPossible,
        "alap" => ConstraintType.AsLateAsPossible,
        "muststarton" => ConstraintType.MustStartOn,
        "mustfinishon" => ConstraintType.MustFinishOn,
        "startnoearlierthan" => ConstraintType.StartNoEarlierThan,
        "startnolaterthan" => ConstraintType.StartNoLaterThan,
        "finishnoearlierthan" => ConstraintType.FinishNoEarlierThan,
        "finishnolaterthan" => ConstraintType.FinishNoLaterThan,
        _ => null,
    };

    // ───────────────────────────── Helpers ─────────────────────────────
    private static DateTime? ParseYmd(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        var trimmed = s.Length >= 10 ? s[..10] : s;
        if (DateTime.TryParseExact(trimmed, "yyyy-MM-dd",
                CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
            return d;
        return null;
    }

    private static string? ToYmd(DateTime d)
    {
        if (d == DateTime.MinValue) return null;
        if (d.Year < 1900 || d.Year > 3000) return null;
        return d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
    }

    private static string? NullIfEmpty(string? s) =>
        string.IsNullOrWhiteSpace(s) ? null : s;

    private static int Fail(string msg)
    {
        WriteError(msg);
        return 2;
    }

    private static void WriteError(string msg) => Console.Error.WriteLine(msg);

    // ───────────────────────────── DTOs ─────────────────────────────
    private sealed class TaskOut
    {
        [JsonPropertyName("task_code")] public string TaskCode { get; set; } = "";
        [JsonPropertyName("level")] public int Level { get; set; }
        [JsonPropertyName("parent_task_code")] public string ParentTaskCode { get; set; } = "";
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("assignee")] public string? Assignee { get; set; }
        [JsonPropertyName("start_date")] public string? StartDate { get; set; }
        [JsonPropertyName("end_date")] public string? EndDate { get; set; }
        [JsonPropertyName("duration")] public int? Duration { get; set; }
        [JsonPropertyName("is_milestone")] public bool IsMilestone { get; set; }
        [JsonPropertyName("auto_schedule")] public bool AutoSchedule { get; set; } = true;
        [JsonPropertyName("note")] public string? Note { get; set; }
        [JsonPropertyName("percent_done")] public int? PercentDone { get; set; }
        [JsonPropertyName("constraint_type")] public string? ConstraintType { get; set; }
        [JsonPropertyName("constraint_date")] public string? ConstraintDate { get; set; }
        [JsonPropertyName("rollup")] public bool Rollup { get; set; }
        [JsonPropertyName("inactive")] public bool Inactive { get; set; }
        [JsonPropertyName("project_boundary")] public string? ProjectBoundary { get; set; }
        [JsonPropertyName("status")] public string? Status { get; set; }
        [JsonPropertyName("deadline")] public string? Deadline { get; set; }
        [JsonPropertyName("baseline_end_date")] public string? BaselineEndDate { get; set; }
    }

    private sealed class DepOut
    {
        [JsonPropertyName("from_task_code")] public string FromTaskCode { get; set; } = "";
        [JsonPropertyName("to_task_code")] public string ToTaskCode { get; set; } = "";
        [JsonPropertyName("type")] public int Type { get; set; }
        [JsonPropertyName("lag")] public int Lag { get; set; }
        [JsonPropertyName("active")] public bool Active { get; set; } = true;
    }

    private sealed class ProjectLineOut
    {
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("line_date")] public string LineDate { get; set; } = "";
        [JsonPropertyName("color")] public string Color { get; set; } = "#888";
        [JsonPropertyName("visible")] public bool Visible { get; set; } = true;
    }

    private sealed class ImportResult
    {
        [JsonPropertyName("tasks")] public List<TaskOut> Tasks { get; set; } = new();
        [JsonPropertyName("dependencies")] public List<DepOut> Dependencies { get; set; } = new();
        [JsonPropertyName("status_date")] public string? StatusDate { get; set; }
        [JsonPropertyName("project_lines")] public List<ProjectLineOut>? ProjectLines { get; set; }
    }

    private sealed class TaskIn
    {
        [JsonPropertyName("task_code")] public string TaskCode { get; set; } = "";
        [JsonPropertyName("parent_task_code")] public string? ParentTaskCode { get; set; }
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("assignee")] public string? Assignee { get; set; }
        [JsonPropertyName("start_date")] public string? StartDate { get; set; }
        [JsonPropertyName("end_date")] public string? EndDate { get; set; }
        [JsonPropertyName("duration")] public int? Duration { get; set; }
        [JsonPropertyName("is_milestone")] public bool IsMilestone { get; set; }
        [JsonPropertyName("auto_schedule")] public bool AutoSchedule { get; set; } = true;
        [JsonPropertyName("note")] public string? Note { get; set; }
        [JsonPropertyName("percent_done")] public int? PercentDone { get; set; }
        [JsonPropertyName("constraint_type")] public string? ConstraintType { get; set; }
        [JsonPropertyName("constraint_date")] public string? ConstraintDate { get; set; }
        [JsonPropertyName("rollup")] public bool Rollup { get; set; }
        [JsonPropertyName("inactive")] public bool Inactive { get; set; }
        [JsonPropertyName("deadline")] public string? Deadline { get; set; }
        [JsonPropertyName("order_index")] public int OrderIndex { get; set; }
    }

    private sealed class DepIn
    {
        [JsonPropertyName("from_task_code")] public string FromTaskCode { get; set; } = "";
        [JsonPropertyName("to_task_code")] public string ToTaskCode { get; set; } = "";
        [JsonPropertyName("type")] public int Type { get; set; }
        [JsonPropertyName("lag")] public int Lag { get; set; }
        [JsonPropertyName("active")] public bool Active { get; set; } = true;
    }

    private sealed class ExportInput
    {
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("start_date")] public string? StartDate { get; set; }
        [JsonPropertyName("end_date")] public string? EndDate { get; set; }
        [JsonPropertyName("status_date")] public string? StatusDate { get; set; }
        [JsonPropertyName("tasks")] public List<TaskIn> Tasks { get; set; } = new();
        [JsonPropertyName("dependencies")] public List<DepIn> Dependencies { get; set; } = new();
    }
}

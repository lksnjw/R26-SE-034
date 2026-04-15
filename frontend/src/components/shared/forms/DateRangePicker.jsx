import Input from "../ui/Input";

function DateRangePicker() {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Input type="date" />
      <Input type="date" />
    </div>
  );
}

export default DateRangePicker;

function Card({ children, className = "" }) {
  return (
    <section className={`surface-panel rounded-2xl p-5 ${className}`}>{children}</section>
  );
}

export default Card;
